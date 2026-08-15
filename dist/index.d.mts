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
import { CallState, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    /** True once the WASM has reported any state for this call. */
    _sawWasmState: boolean;
    /** Whether this call has already finished. */
    get ended(): boolean;
    /** True for a call the peer placed to us. */
    readonly incoming: boolean;
    /** The peer, as reported by the offer. */
    peerJid: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: (reason?: string) => void;
    mute: (muted: boolean) => void;
    /** Answer a ringing inbound call. */
    answer: (opts?: { audioSource?: string; withMic?: boolean }) => void;
    /** Decline a ringing inbound call. */
    reject: () => void;
    /**
     * Push uplink audio into a call opened with a `stream:` audioSource.
     * The PCM must match that source's declared format.
     */
    writeAudio: (chunk: Uint8Array | Buffer) => boolean;
    /** Drop uplink audio that has not played yet; returns frames discarded. */
    clearAudio: () => number;
    waitForEnd: () => Promise<string>;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
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
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => Promise<void>;
}
