/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";

import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport, type RelayListUpdatePayload } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";

export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";

const SHA256_LEN = 32;

const loadBaileys = async (): Promise<any> => {
  try {
    return await import("@whiskeysockets/baileys");
  } catch {
    throw new Error(
      "Could not import @whiskeysockets/baileys. Install it as a peer dependency.",
    );
  }
};

const toBareJid = (jid: string): string => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const computeHkdf = (
  key: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

/** How long to wait for the WASM to confirm a local hangup before resolving. */
const HANGUP_CONFIRM_MS = 2_000;

/**
 * WASM call event for a call it rejected on its own, carrying `reason_code`.
 * Observed when an inbound offer was auto-rejected as a pending call.
 */
const WASM_EVENT_CALL_REJECTED = 92;

/** Retry cadence for accepting an inbound call the WASM has not registered yet. */
const ACCEPT_RETRY_MS = 700;
const ACCEPT_MAX_ATTEMPTS = 4;

const isCallReceiptNode = (node: any): boolean => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
  #state: CallState = CallState.Idle;
  #endResolver!: (reason: string) => void;
  readonly #endPromise: Promise<string>;
  #endTimer: NodeJS.Timeout | null = null;
  #hangupTimer: NodeJS.Timeout | null = null;
  #ended = false;
  /**
   * Set by `end()`. Kept separate from `#ended` so a local hangup does not
   * suppress the `ended` event: marking the call ended here used to make the
   * subsequent `_forceEnd` a no-op, so `ended` never fired and `waitForEnd()`
   * never settled.
   */
  #endRequested = false;

  /** @internal mirrors the source path for the audio feeder */
  _audioSource: string = "silence";
  /** @internal set by VoipClient; resolves the live feeder at call time */
  _writeAudio: ((chunk: Uint8Array | Buffer) => boolean) | null = null;
  /** @internal set by VoipClient */
  _clearAudio: (() => number) | null = null;
  /** @internal set by VoipClient for a ringing inbound call */
  _answer: ((opts: { audioSource?: string; withMic?: boolean }) => void) | null = null;
  /** @internal set by VoipClient for a ringing inbound call */
  _reject: (() => void) | null = null;

  /** True for a call the peer placed to us. */
  readonly incoming: boolean;
  /** The peer, as reported by the offer. */
  peerJid = "";

  constructor(
    public readonly callId: string,
    private readonly engine: WasmEngine,
    durationMs: number,
    incoming = false,
  ) {
    super();
    this.incoming = incoming;
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    if (durationMs > 0) {
      this.#endTimer = setTimeout(() => this.end("timeout"), durationMs);
    }
  }

  get state(): CallState { return this.#state; }

  /**
   * Hang up. Idempotent.
   *
   * The WASM normally reports `Ending`/`Idle` straight after, which is what
   * emits `ended`. A fallback timer resolves anyway if that report never
   * arrives, so `waitForEnd()` cannot hang forever.
   */
  end = (reason = "hangup"): void => {
    if (this.#ended || this.#endRequested) return;
    this.#endRequested = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    try { this.engine.endCall(0, true); } catch {}
    this.#hangupTimer = setTimeout(() => this._forceEnd(reason), HANGUP_CONFIRM_MS);
    if (this.#hangupTimer.unref) this.#hangupTimer.unref();
  };

  mute = (muted: boolean): void => {
    try { this.engine.setMute(muted); } catch {}
  };

  /**
   * Answer a ringing inbound call.
   *
   * `audioSource` behaves exactly as it does for an outbound call, including the
   * `stream:` form for live audio. Only meaningful while the call is ringing.
   */
  answer = (opts: { audioSource?: string; withMic?: boolean } = {}): void => {
    if (!this.incoming) throw new Error("answer() is only for incoming calls");
    this._answer?.(opts);
  };

  /** Decline a ringing inbound call. */
  reject = (): void => {
    if (!this.incoming) throw new Error("reject() is only for incoming calls; use end()");
    this._reject?.();
  };

  /**
   * Push uplink audio into a call opened with a `stream:` audioSource.
   *
   * The PCM must match the format declared in that source, e.g.
   * `audioSource: "stream:s16le@24000"` for the Live API's 24 kHz output.
   * Returns false when the call has no stream source or is not capturing yet.
   */
  writeAudio = (chunk: Uint8Array | Buffer): boolean => this._writeAudio?.(chunk) ?? false;

  /**
   * Drop uplink audio that has not played yet, and return how many frames were
   * discarded. Call this on a barge-in so the previous turn stops immediately.
   */
  clearAudio = (): number => this._clearAudio?.() ?? 0;

  waitForEnd = (): Promise<string> => this.#endPromise;

  /** True once the WASM has reported any state for this call. */
  _sawWasmState = false;

  /** Whether this call has already finished. */
  get ended(): boolean { return this.#ended; }

  /** @internal — called by VoipClient on WASM call-state change */
  _updateState = (state: number): void => {
    this._sawWasmState = true;
    this.#state = state as CallState;
    if (state === CallState.PreacceptReceived) this.emit("ringing");
    else if (state === CallState.Active) this.emit("connected");
    else if (state === CallState.Idle || state === CallState.Ending) {
      this._forceEnd("ended");
    }
  };

  /** @internal */
  _emitAudio = (pcm: Float32Array): void => { this.emit("audio", pcm); };

  /** @internal */
  _forceEnd = (reason: string): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    if (this.#hangupTimer) { clearTimeout(this.#hangupTimer); this.#hangupTimer = null; }
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

/**
 * Top-level client. Connects to WhatsApp, places calls, and emits incoming ones.
 *
 * Events:
 *   `incoming` — `(call: ActiveCall)` for each inbound offer. Call `answer()` or
 *                `reject()` on it. If nothing handles the event the call is
 *                declined, because leaving an offer unanswered just rings out.
 *   `error`    — `(err: Error)` for failures with nowhere else to go.
 */
export class VoipClient extends EventEmitter {
  readonly #config: VoipSdkConfig;
  #engine: WasmEngine | null = null;
  #relay: RelayRtcTransport | null = null;
  #signaling: SignalingBridge | null = null;
  #sock: any = null;
  #activeCall: ActiveCall | null = null;
  #baileys: any = null;

  // Capture state populated when WASM negotiates audio params
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder: AudioFeeder | null = null;

  /** Calls already seen, so a re-sent offer does not ring twice. */
  readonly #seenIncomingCallIds = new Set<string>();
  /** WASM call-event types already logged, to keep the diagnostic quiet. */
  readonly #seenEventTypes = new Set<number>();

  constructor(config: VoipSdkConfig) {
    super();
    this.#config = config;
  }

  /** Connect to WhatsApp and bring up the WASM VoIP stack. */
  connect = async (): Promise<void> => {
    this.#baileys = await loadBaileys();
    const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
    const makeSocket: (opts: any) => any =
      makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;

    const authDir = resolve(this.#config.authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: any = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const createSocket = () => makeSocket({
      auth: state,
      emitOwnEvents: true,
      logger: silentLogger,
    });

    // Connect with auto-reconnect on the post-QR 515 stream-error path.
    //
    // The 515 handling needs a process-level hook because baileys throws it
    // outside any promise chain, but it must not cost the host application its
    // own crash guard: the previous `process.removeAllListeners` wiped every
    // pre-existing uncaughtException handler permanently, so an embedding app
    // silently lost its safety net (and died on the next unrelated throw).
    // Instead, detach the host's handlers for the duration of the connect and
    // put them back afterwards.
    const hostExceptionHandlers = process.listeners("uncaughtException");
    let ownExceptionHandler: ((err: any) => void) | null = null;

    const restoreHostExceptionHandlers = (): void => {
      if (ownExceptionHandler) {
        process.removeListener("uncaughtException", ownExceptionHandler);
        ownExceptionHandler = null;
      }
      for (const handler of hostExceptionHandlers) {
        if (!process.listeners("uncaughtException").includes(handler)) {
          process.on("uncaughtException", handler as any);
        }
      }
    };

    try {
      await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false;
      let retries = 0;
      const maxRetries = 5;

      const connectSocket = () => {
        this.#sock = createSocket();
        this.#sock.ev.on("creds.update", saveCreds);

        for (const handler of hostExceptionHandlers) {
          process.removeListener("uncaughtException", handler as any);
        }
        if (ownExceptionHandler) process.removeListener("uncaughtException", ownExceptionHandler);
        ownExceptionHandler = (err: any) => {
          const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
          if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
            retries += 1;
            setTimeout(connectSocket, 1500);
          } else if (!opened) {
            rejectOpen(err);
          } else {
            // Past open: this is the host's problem again, not ours.
            for (const handler of hostExceptionHandlers) {
              try { (handler as any)(err); } catch {}
            }
          }
        };
        process.on("uncaughtException", ownExceptionHandler);

        this.#sock.ev.on("connection.update", (update: any) => {
          if (update.qr) {
            void import("qrcode-terminal")
              .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
              .catch(() => {
                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                console.log(update.qr);
              });
          }
          if (update.connection === "open") {
            opened = true;
            restoreHostExceptionHandlers();
            resolveOpen();
            return;
          }
          if (update.connection === "close" && !opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect =
              statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
            if (shouldReconnect && retries < maxRetries) {
              retries += 1;
              setTimeout(connectSocket, 1000);
            } else {
              rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
            }
          }
        });
      };

      connectSocket();
      });
    } finally {
      restoreHostExceptionHandlers();
    }

    this.#signaling = new SignalingBridge({ sock: this.#sock });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState.creds.me?.id;
    const selfLidJid = this.#sock.authState.creds.me?.lid;
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    this.#sock.ws.on("CB:call", (node: any) => {
      // The WASM must have the offer before it can be accepted, and delivery is
      // queued and can take seconds. Surfacing the call earlier meant answer()
      // reached a WASM that had never heard of the call, so acceptCall() was a
      // silent no-op — the call logged as answered and then just rang out.
      const delivered = this.#signaling!.processIncomingCall(
        node, this.#engine!, this.#activeCall?.callId ?? "",
      );
      void delivered
        .then(() => this.#handleIncomingOffer(node))
        .catch((err) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
    });
    this.#sock.ws.on("CB:receipt", (node: any) => {
      if (!isCallReceiptNode(node)) return;
      this.#signaling!.processIncomingReceipt(node, this.#engine!, this.#activeCall?.callId ?? "");
    });
  };

  /** Place an outbound voice call. */
  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number } = {},
  ): Promise<ActiveCall> => {
    if (!this.#engine || !this.#signaling) throw new Error("Not connected. Call connect() first.");
    if (this.#activeCall) throw new Error("A call is already active.");

    const targetNumber = phoneNumber.replace(/\D/g, "");
    const targetPnJid = `${targetNumber}@s.whatsapp.net`;
    // No auto-hangup by default. The old default of 120_000 silently ended
    // every call after two minutes, which reads as a bug to callers who
    // never asked for a duration. Pass durationMs explicitly to opt in.
    const durationMs = opts.durationMs ?? 0;
    const audioSource = opts.audioSource ?? "silence";

    const peerLid = await this.#signaling.resolveLid(targetPnJid);
    if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`);

    for (const jid of [targetPnJid, peerLid]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();

    const call = new ActiveCall(callId, this.#engine, durationMs);
    call._audioSource = audioSource;
    this.#registerCall(call);

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: false,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  /**
   * Tear down the WhatsApp socket and release resources.
   *
   * Await the returned promise if you care about the memory actually coming
   * back: engine teardown has to wait for ~20 worker threads to exit.
   */
  disconnect = async (): Promise<void> => {
    this.#activeCall?._forceEnd("disconnect");
    this.#activeCall = null;
    this.#feeder?.stop?.();
    this.#feeder = null;
    this.#relay?.closeAll();
    const engine = this.#engine;
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
    try { this.#sock?.end?.(); } catch {}
    this.#sock = null;
    this.#capturePtr = 0;
    this.#captureChunkBytes = 0;
    await engine?.destroy();
  };

  /**
   * Wire a call into the client: audio sink, active-call slot, and teardown.
   *
   * Shared by both directions. Without the `ended` handler `#activeCall` stayed
   * set for the lifetime of the client and every later call() threw "A call is
   * already active."; it also stops the feeder, which otherwise leaks an ffmpeg
   * process when a call ends without the WASM reporting a capture stop.
   */
  #registerCall = (call: ActiveCall): void => {
    // Resolved lazily: the feeder only exists once the WASM starts capturing.
    call._writeAudio = (chunk) => this.#feeder?.write(chunk) ?? false;
    call._clearAudio = () => this.#feeder?.flush() ?? 0;
    this.#activeCall = call;

    call.once("ended", () => {
      if (this.#activeCall === call) this.#activeCall = null;
      this.#feeder?.stop();
      this.#feeder = null;
    });
  };

  /**
   * Turn an inbound `<offer>` into a ringing ActiveCall and emit it.
   *
   * The offer has already been handed to the WASM by the signalling bridge,
   * which drives preaccept and the relay election on its own; answering only
   * commits to the call.
   */
  #handleIncomingOffer = (node: any): void => {
    const { getBinaryNodeChild, getAllBinaryNodeChildren } = this.#baileys;
    const offer = getBinaryNodeChild(node, "offer");
    if (!offer) return;

    const callId = String(offer.attrs?.["call-id"] ?? "");
    if (!callId || this.#seenIncomingCallIds.has(callId)) return;

    // An offer-shaped "call ended" notification is not a live call; engaging it
    // earns an accept error from the server.
    if (offer.attrs?.is_call_ended === "1" || offer.attrs?.terminate_reason) return;

    this.#seenIncomingCallIds.add(callId);
    if (this.#seenIncomingCallIds.size > 256) {
      this.#seenIncomingCallIds.delete(this.#seenIncomingCallIds.values().next().value as string);
    }

    const peerJid = String(offer.attrs?.["call-creator"] ?? node.attrs?.from ?? "");
    const children = getAllBinaryNodeChildren(offer) ?? [];
    const isVideo = children.some((c: any) => c.tag === "video");
    const isGroup = !!offer.attrs?.["group-jid"] || children.some((c: any) => c.tag === "group_info");

    const call = new ActiveCall(callId, this.#engine!, 0, true);
    call.peerJid = peerJid;

    // Only one call can be up at a time: the WASM holds a single call context.
    if (this.#activeCall) {
      try { this.#engine?.rejectCall(); } catch {}
      call._forceEnd("busy");
      return;
    }

    call._answer = ({ audioSource = "silence", withMic = true }) => {
      call._audioSource = audioSource;

      // acceptCall() is fire-and-forget inside the WASM: if the call context is
      // not ready yet it does nothing and reports nothing. Retry a few times
      // until the WASM reports a state for this call, which is the only
      // observable proof it took the offer.
      let attempt = 0;
      const tryAccept = () => {
        if (call.ended || this.#activeCall !== call) return;
        if (attempt > 0 && call._sawWasmState) return;
        attempt += 1;
        let info: unknown;
        try { info = this.#engine!.getCallInfo(); } catch {}
        console.log(
          `[baileys-caller] accepting call ${call.callId} (attempt ${attempt}/${ACCEPT_MAX_ATTEMPTS});` +
          ` WASM call info: ${JSON.stringify(info ?? null).slice(0, 300)}`,
        );
        try {
          this.#engine!.acceptCall(withMic, false);
        } catch (err) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          call._forceEnd("answer_failed");
          return;
        }
        if (attempt < ACCEPT_MAX_ATTEMPTS) {
          const t = setTimeout(tryAccept, ACCEPT_RETRY_MS);
          if (t.unref) t.unref();
        }
      };
      tryAccept();
    };
    call._reject = () => {
      try { this.#engine!.rejectCall(); } catch {}
      call._forceEnd("rejected");
    };

    this.#registerCall(call);

    console.log(
      `[baileys-caller] incoming call ${callId} from ${peerJid}` +
      `${isVideo ? " (video)" : ""}${isGroup ? " (group)" : ""}`,
    );

    // Nothing listening means nobody can answer, and an unanswered offer just
    // rings out — decline it explicitly instead.
    if (this.listenerCount("incoming") === 0) {
      call._reject?.();
      return;
    }
    this.emit("incoming", call, { isVideo, isGroup, peerJid });
  };

  // ─── private ──────────────────────────────────────────────────────────────

  #handleCallEvent = (eventType: number, eventData?: string): void => {
    // Only three event types are acted on. During an inbound call the useful
    // question is what the WASM reported at all, so anything unrecognised is
    // logged once per type instead of being dropped in silence.
    if (eventType !== 16 && eventType !== 156 && eventType !== 2 && !this.#seenEventTypes.has(eventType)) {
      this.#seenEventTypes.add(eventType);
      console.log(
        `[baileys-caller] unhandled WASM call event ${eventType}:`,
        String(eventData ?? "").slice(0, 300),
      );
    }
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        this.#activeCall?._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData) as RelayListUpdatePayload;
        this.#relay?.updateRelayList(update);
      } catch {}
    } else if (eventType === 2) {
      this.#activeCall?._forceEnd("remote_end");
    } else if (eventType === WASM_EVENT_CALL_REJECTED) {
      // The WASM declined the call itself, before it ever became an active
      // context. Retrying acceptCall against it is pointless.
      let reason = "unknown";
      try { reason = String(JSON.parse(eventData ?? "{}").reason_code ?? "unknown"); } catch {}
      console.log(`[baileys-caller] the WASM rejected call ${this.#activeCall?.callId ?? "?"} (reason ${reason})`);
      this.#activeCall?._forceEnd(`wasm_rejected_${reason}`);
    }
  };

  #handleAudioCaptureInit = (config: {
    sampleRate: number; channels: number; bitsPerSample: number; framesPerChunk: number;
  }): void => {
    if (!this.#engine) return;
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
  };

  #handleAudioCaptureStart = (): void => {
    if (!this.#engine || !this.#capturePtr) return;
    const audioSource = this.#activeCall?._audioSource ?? "silence";
    this.#feeder = new AudioFeeder(
      this.#captureSampleRate,
      this.#captureChannels,
      this.#captureFramesPerChunk,
      (chunk) => {
        if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
      },
      audioSource,
    );
    this.#feeder.start();
  };

  #handleAudioCaptureStop = (): void => {
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
  };
}
