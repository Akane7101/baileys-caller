/**
 * Shared type definitions for baileys-caller.
 *
 * @author ShellTear
 */

/** Audio stream configuration reported by the WASM. */
export type AudioConfig = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  framesPerChunk: number;
};

/** Options for placing a call. */
export type CallOptions = {
  /** Phone number, digits only (e.g. `"12345678901"`). */
  to: string;
  /**
   * Audio source for the uplink. One of:
   *   - a file path or URL (MP3/WAV/…), decoded by ffmpeg
   *   - `"silence"` for an empty uplink (default)
   *   - `"lavfi:<filtergraph>"` for an ffmpeg filter source
   *   - `"stream:<codec>@<rate>[:<channels>]"` for audio pushed in with
   *     `ActiveCall.writeAudio()`, e.g. `"stream:s16le@24000"` to feed the
   *     Gemini Live API's 24 kHz PCM output into the call.
   */
  audioSource?: string;
  /** Auto-hangup after N ms. Omit or `0` for no automatic hangup. */
  durationMs?: number;
};

/** Events emitted by an `ActiveCall`. */
export type CallEvents = {
  ringing: () => void;
  connected: () => void;
  /** 16 kHz mono Float32 PCM frame from the remote peer. */
  audio: (pcm: Float32Array) => void;
  /**
   * Encoded H.264 access unit from a peer's camera. The WASM does not decode
   * pixels in this headless build, so `data` is the raw compressed frame — hand
   * it to an external decoder (ffmpeg/WebCodecs) if you need images.
   */
  video: (frame: VideoFrame) => void;
  /** Peer's mid-call video state changed (upgrade request/accept, enable/stop). */
  videoState: (state: { jid: string; state: number }) => void;
  /** Group roster changed (participant joined/left/connected). */
  participants: (roster: unknown) => void;
  /** Reason: `"hangup"` | `"timeout"` | `"rejected"` | `"remote_end"` | `"disconnect"` | etc. */
  ended: (reason: string) => void;
  error: (err: Error) => void;
};

/** One encoded video frame received from a peer. */
export type VideoFrame = {
  /** The peer device this frame is attributed to. */
  userJid: string;
  /** Encoded H.264 access unit (Annex-B). Not decoded to pixels. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Clockwise quarter turns to display upright (0..3). */
  orientation: number;
  format: number;
  isKeyFrame: boolean;
  timestamp: number;
};

/** Options for placing a group call. */
export type GroupCallOptions = {
  /** Start the call with video advertised in the offer. */
  video?: boolean;
  /** Bind the call to an existing group JID (`...@g.us`). Omit for ad-hoc. */
  groupJid?: string;
  /** Auto-hangup after N ms. Omit or `0` for no automatic hangup. */
  durationMs?: number;
};

/** Top-level SDK configuration. */
export type VoipSdkConfig = {
  /** Path to a Baileys multi-file auth state directory. */
  authDir: string;
};

/** Mirrors the WhatsApp WASM `CallState` enum. */
export const CallState = {
  Idle: 0,
  Calling: 1,
  PreacceptReceived: 2,
  ReceivedCall: 3,
  AcceptSent: 4,
  AcceptReceived: 5,
  Active: 6,
  ActiveElsewhere: 7,
  Ending: 13,
} as const;
export type CallState = (typeof CallState)[keyof typeof CallState];

/** Relay list update payload from WASM call event 156. */
export type RelayListUpdate = {
  relay_key: string;
  relay_tokens: string[];
  auth_tokens?: string[];
  enable_edgeray_dtls_active_mode?: boolean;
  relays: ReadonlyArray<{
    relay_id: number;
    relay_name: string;
    token_id: number;
    auth_token_id?: number;
    addresses: ReadonlyArray<{
      protocol: number;
      ipv4?: string;
      ipv6?: string;
      port?: number;
      port_v6?: number;
    }>;
  }>;
};
