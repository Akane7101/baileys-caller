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
import { WasmEngine } from "./wasm-engine.mjs";
import { CallState, type VoipSdkConfig, type GroupCallOptions } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig, GroupCallOptions, VideoFrame } from "./types.mjs";
export { CallState } from "./types.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    /** @internal set by VoipClient; resolves the live feeder at call time */
    _writeAudio: ((chunk: Uint8Array | Buffer) => boolean) | null;
    /** @internal set by VoipClient */
    _clearAudio: (() => number) | null;
    /** @internal set by VoipClient for a ringing inbound call */
    _answer: ((opts: {
        audioSource?: string;
        withMic?: boolean;
    }) => void) | null;
    /** @internal set by VoipClient for a ringing inbound call */
    _reject: (() => void) | null;
    /** True for a call the peer placed to us. */
    readonly incoming: boolean;
    /** The peer, as reported by the offer. */
    peerJid: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number, incoming?: boolean);
    get state(): CallState;
    /**
     * Hang up. Idempotent.
     *
     * The WASM normally reports `Ending`/`Idle` straight after, which is what
     * emits `ended`. A fallback timer resolves anyway if that report never
     * arrives, so `waitForEnd()` cannot hang forever.
     */
    end: (reason?: string) => void;
    mute: (muted: boolean) => void;
    /**
     * Answer a ringing inbound call.
     *
     * `audioSource` behaves exactly as it does for an outbound call, including the
     * `stream:` form for live audio. Only meaningful while the call is ringing.
     */
    answer: (opts?: {
        audioSource?: string;
        withMic?: boolean;
    }) => void;
    /** Decline a ringing inbound call. */
    reject: () => void;
    /** True for a group call (ad-hoc or group-bound). */
    isGroup: boolean;
    /** @internal set by VoipClient for group calls. */
    _addParticipant: ((phoneNumber: string) => Promise<void>) | null;
    /** @internal set by VoipClient for group calls. */
    _removeParticipant: ((jid: string) => void) | null;
    /** Add a participant to a group call by phone number (digits only). */
    addParticipant: (phoneNumber: string) => Promise<void>;
    /** Remove a participant from a group call by their JID. */
    removeParticipant: (jid: string) => void;
    /** Ask the peer to upgrade this audio call to video. */
    requestVideo: () => void;
    /** Accept a peer's incoming video (mid-call upgrade or a group participant). */
    acceptVideo: (jid: string) => void;
    /** Toggle our own outgoing video track. */
    setVideoMute: (enable: boolean) => void;
    /**
     * Push uplink audio into a call opened with a `stream:` audioSource.
     *
     * The PCM must match the format declared in that source, e.g.
     * `audioSource: "stream:s16le@24000"` for the Live API's 24 kHz output.
     * Returns false when the call has no stream source or is not capturing yet.
     */
    writeAudio: (chunk: Uint8Array | Buffer) => boolean;
    /**
     * Drop uplink audio that has not played yet, and return how many frames were
     * discarded. Call this on a barge-in so the previous turn stops immediately.
     */
    clearAudio: () => number;
    waitForEnd: () => Promise<string>;
    /** True once the WASM has reported any state for this call. */
    _sawWasmState: boolean;
    /** True once acceptCall has been issued for this (active) call. */
    _accepted: boolean;
    /** Whether this call has already finished. */
    get ended(): boolean;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
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
export declare class VoipClient extends EventEmitter {
    #private;
    constructor(config: VoipSdkConfig);
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => Promise<ActiveCall>;
    /**
     * Place an outbound group call.
     *
     * Needs at least two other participants (WhatsApp's minimum for an initial
     * group offer is self + 2). The WASM owns the group key epoch, SRTP, and relay
     * subscriptions; this only resolves each participant's device roster and hands
     * it over. Pass `groupJid` to bind the call to an existing group, or omit it
     * for an ad-hoc group call.
     */
    callGroup: (phoneNumbers: string[], opts?: GroupCallOptions) => Promise<ActiveCall>;
    disconnect: () => Promise<void>;
}
