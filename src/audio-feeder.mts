/**
 * Audio feeder.
 *
 * Meters PCM frames out to the WASM uplink at chunk cadence.
 *
 * `source` accepts:
 *   - `"silence"` (or empty)         — a silent uplink
 *   - a file path or URL             — decoded by ffmpeg
 *   - `"lavfi:<filtergraph>"`        — an ffmpeg filter source
 *   - `"stream:<codec>@<rate>[:ch]"` — raw PCM pushed in with `write()`,
 *                                      e.g. `stream:s16le@24000`
 *
 * The stream form exists for live sources such as a speech model's audio output.
 * It deliberately does not use ffmpeg: ffmpeg withholds output on a pipe until
 * stdin closes (measured — nothing arrives for a full second of input, then
 * everything at EOF), which is unusable for a live conversation. Stream sources
 * are therefore decoded and resampled in-process, which also means `flush()`
 * can drop *all* pending audio for barge-in rather than leaving an unreachable
 * tail inside ffmpeg's buffers.
 *
 * @author ShellTear
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_CHUNKS = 1024;
const DEFAULT_WARMUP_MS = 500;

/** Raw PCM encodings accepted by a `stream:` source. */
const STREAM_CODECS: Record<string, { bytes: number; read: (b: Buffer, off: number) => number }> = {
  s16le: { bytes: 2, read: (b, off) => b.readInt16LE(off) / 32768 },
  s16be: { bytes: 2, read: (b, off) => b.readInt16BE(off) / 32768 },
  f32le: { bytes: 4, read: (b, off) => b.readFloatLE(off) },
  f32be: { bytes: 4, read: (b, off) => b.readFloatBE(off) },
};

/** Parsed `stream:<codec>@<rate>[:<channels>]` source. */
type StreamInput = {
  codec: keyof typeof STREAM_CODECS;
  sampleRate: number;
  channels: number;
};

const parseStreamSource = (source: string): StreamInput | null => {
  if (!source?.startsWith("stream:")) return null;
  const match = /^([a-z0-9]+)@(\d+)(?::(\d+))?$/i.exec(source.slice("stream:".length));
  if (!match) return null;
  const codec = match[1]!.toLowerCase();
  if (!(codec in STREAM_CODECS)) {
    throw new Error(`Unsupported stream codec "${codec}". Supported: ${Object.keys(STREAM_CODECS).join(", ")}`);
  }
  const sampleRate = Number(match[2]);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid stream sample rate in "${source}"`);
  }
  return { codec, sampleRate, channels: match[3] ? Number(match[3]) : 1 };
};

export class AudioFeeder {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #pending = Buffer.alloc(0);
  #queue: Float32Array[] = [];
  #emitTimer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #warmupUntilMs = 0;
  #running = false;

  droppedChunks = 0;
  underflowChunks = 0;
  bytesProduced = 0;
  chunksEmitted = 0;
  bytesWritten = 0;

  readonly #streamInput: StreamInput | null;
  /** Leftover bytes of a partial input frame, carried between writes. */
  #streamRemainder = Buffer.alloc(0);
  /** Samples resampled but not yet chunked. */
  #streamSamples: number[] = [];
  /** Fractional read position into the input stream, for resampling. */
  #resamplePos = 0;
  /** Last input sample, so interpolation survives a write boundary. */
  #resamplePrev = 0;
  #resamplePrimed = false;

  /** True when audio is pushed in with `write()` rather than read from a source. */
  get isStreaming(): boolean { return this.#streamInput !== null; }

  /** Chunks waiting to go out. */
  get queuedChunks(): number { return this.#queue.length; }

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly framesPerChunk: number,
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly source: string = "silence",
  ) {
    this.#streamInput = parseStreamSource(source);
  }

  start = (): void => {
    if (this.#running) return;
    this.#running = true;

    const chunkSamples = this.framesPerChunk * this.channels;
    const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;

    if (!this.#streamInput) {
      this.#proc = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-thread_queue_size", "512",
        ...this.#resolveInputArgs(),
        "-f", "f32le",
        "-ac", String(this.channels),
        "-ar", String(this.sampleRate),
        "pipe:1",
      ]);

      this.#proc.stdout.on("data", (chunk: Buffer) => {
        this.#pending = Buffer.concat([this.#pending, chunk]);
        while (this.#pending.length >= chunkBytes) {
          if (this.#queue.length >= MAX_QUEUED_CHUNKS) {
            this.#proc?.stdout.pause();
            break;
          }
          const frame = this.#pending.subarray(0, chunkBytes);
          this.#pending = this.#pending.subarray(chunkBytes);
          const out = new Float32Array(chunkSamples);
          out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
          this.bytesProduced += chunkBytes;
          this.#queue.push(out);
        }
      });

      this.#proc.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`[AudioFeeder] ${chunk.toString().trim()}\n`);
      });

      this.#proc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          process.stderr.write(`[AudioFeeder] ffmpeg exited with code=${code}\n`);
        }
        this.#proc = null;
      });
    }

    this.#nextEmitAtMs = 0;
    // A live stream has nothing buffered yet, and waiting would only add
    // latency; silence is emitted on underflow anyway.
    this.#warmupUntilMs = this.#streamInput ? 0 : Date.now() + DEFAULT_WARMUP_MS;
    this.#scheduleNext(chunkSamples, chunkIntervalMs);
  };

  stop = (): void => {
    this.#running = false;
    if (this.#emitTimer) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = null;
    }
    this.#proc?.kill("SIGTERM");
    this.#proc = null;
    this.#pending = Buffer.alloc(0);
    this.#queue = [];
    this.#warmupUntilMs = 0;
    this.#streamRemainder = Buffer.alloc(0);
    this.#streamSamples = [];
    this.#resamplePos = 0;
    this.#resamplePrev = 0;
    this.#resamplePrimed = false;
  };

  /**
   * Push raw PCM in the format declared by a `stream:` source.
   *
   * Input is downmixed to mono if needed and resampled to the call's capture
   * rate. Returns false when there is no stream source or the feeder is stopped.
   */
  write = (chunk: Uint8Array | Buffer): boolean => {
    const input = this.#streamInput;
    if (!input || !this.#running) return false;

    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.bytesWritten += buf.byteLength;

    const { bytes, read } = STREAM_CODECS[input.codec]!;
    const frameBytes = bytes * input.channels;
    const data = this.#streamRemainder.length
      ? Buffer.concat([this.#streamRemainder, buf])
      : buf;

    const frameCount = Math.floor(data.length / frameBytes);
    this.#streamRemainder = data.subarray(frameCount * frameBytes);
    if (!frameCount) return true;

    // Downmix to mono.
    const mono = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < input.channels; c++) {
        sum += read(data, i * frameBytes + c * bytes);
      }
      mono[i] = sum / input.channels;
    }

    this.#resampleInto(mono, input.sampleRate);
    this.#drainStreamSamples();
    return true;
  };

  /**
   * Linear resample from the input rate to the capture rate, preserving
   * fractional position and the previous sample across calls so writes join
   * seamlessly.
   */
  #resampleInto = (mono: Float32Array, inputRate: number): void => {
    if (!mono.length) return;

    if (inputRate === this.sampleRate) {
      for (const sample of mono) this.#streamSamples.push(sample);
      this.#resamplePrev = mono[mono.length - 1]!;
      this.#resamplePrimed = true;
      return;
    }

    const step = inputRate / this.sampleRate;
    if (!this.#resamplePrimed) {
      this.#resamplePrev = mono[0]!;
      this.#resamplePrimed = true;
    }

    // #resamplePos is relative to a virtual buffer whose index -1 holds the
    // previous write's final sample.
    let pos = this.#resamplePos;
    while (pos < mono.length) {
      const base = Math.floor(pos);
      const frac = pos - base;
      const a = base < 0 ? this.#resamplePrev : mono[base]!;
      const b = base + 1 < mono.length ? mono[base + 1]! : null;
      // Without the next sample the interpolation target is unknown; stop and
      // resume once more input arrives.
      if (b === null && frac > 0) break;
      this.#streamSamples.push(b === null ? a : a + (b - a) * frac);
      pos += step;
    }
    this.#resamplePrev = mono[mono.length - 1]!;
    this.#resamplePos = pos - mono.length;
  };

  #drainStreamSamples = (): void => {
    const chunkSamples = this.framesPerChunk * this.channels;
    while (this.#streamSamples.length >= chunkSamples) {
      if (this.#queue.length >= MAX_QUEUED_CHUNKS) {
        // Drop the oldest audio rather than growing without bound.
        this.#queue.shift();
        this.droppedChunks += 1;
      }
      const out = new Float32Array(this.#streamSamples.splice(0, chunkSamples));
      this.bytesProduced += out.byteLength;
      this.#queue.push(out);
    }
  };

  /** Signal end of input on a stream source. */
  endInput = (): void => {
    if (!this.#streamInput) return;
    try { this.#proc?.stdin?.end(); } catch {}
  };

  /**
   * Drop audio that has not been sent to the call yet, and return how many
   * chunks were discarded.
   *
   * Used for barge-in: the outbound queue holds up to MAX_QUEUED_CHUNKS frames
   * (about 20 seconds at 20 ms per frame), so without this the previous turn
   * would keep playing long after the peer interrupted. For stream sources this
   * clears everything, including partially resampled audio.
   */
  flush = (): number => {
    const dropped = this.#queue.length;
    this.#queue = [];
    this.#pending = Buffer.alloc(0);
    this.#streamSamples = [];
    this.#streamRemainder = Buffer.alloc(0);
    this.#resamplePos = 0;
    this.#resamplePrimed = false;
    this.droppedChunks += dropped;
    if (this.#proc?.stdout.isPaused()) this.#proc.stdout.resume();
    return dropped;
  };

  #resolveInputArgs = (): string[] => {
    if (!this.source || this.source === "silence") {
      return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
    }
    if (this.source.startsWith("lavfi:")) {
      return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
    }
    return ["-i", this.source];
  };

  #scheduleNext = (chunkSamples: number, chunkIntervalMs: number): void => {
    if (!this.#running) return;
    const now = Date.now();
    if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;
    const delayMs = Math.max(0, this.#nextEmitAtMs - now);

    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      if (this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
        this.#nextEmitAtMs = Date.now() + 10;
        this.#scheduleNext(chunkSamples, chunkIntervalMs);
        return;
      }
      this.#flushOne(chunkSamples);
      this.#nextEmitAtMs += chunkIntervalMs;
      this.#scheduleNext(chunkSamples, chunkIntervalMs);
    }, delayMs);
  };

  #flushOne = (chunkSamples: number): void => {
    let nextChunk = this.#queue.shift();
    if (!nextChunk) {
      nextChunk = new Float32Array(chunkSamples);
      this.underflowChunks += 1;
    }
    this.chunksEmitted += 1;
    this.onChunk(nextChunk);
    if (this.#proc?.stdout.isPaused() && this.#queue.length <= MAX_QUEUED_CHUNKS / 4) {
      this.#proc.stdout.resume();
    }
  };
}
