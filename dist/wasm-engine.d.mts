export type WasmAudioConfig = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    framesPerChunk: number;
};
export type WasmEngineCallbacks = {
    onSignalingXmpp?: (peerJid: string, callId: string, xmlPayload: Uint8Array) => void;
    onCallEvent?: (eventType: number, eventData?: string) => void;
    onVoipReady?: () => void;
    sendDataToRelay?: (data: Uint8Array, ip: string, port: number) => number;
    onLog?: (level: string, message: string) => void;
    onAudioCaptureInit?: (config: WasmAudioConfig) => void;
    onAudioCaptureStart?: () => void;
    onAudioCaptureStop?: () => void;
    onAudioPlaybackInit?: (config: WasmAudioConfig) => void;
    onAudioPlaybackStart?: () => void;
    onAudioPlaybackStop?: () => void;
    onAudioPlaybackData?: (audioData: Float32Array) => void;
    onVideoFrame?: (frame: {
        userJid: string;
        data: Uint8Array;
        width: number;
        height: number;
        orientation: number;
        format: number;
        isKeyFrame: boolean;
        timestamp: number;
    }) => void;
    cryptoHkdf?: (key: Uint8Array, salt: Uint8Array | null, info: Uint8Array, length: number) => Uint8Array;
    hmacSha256?: (data: Uint8Array, key: Uint8Array) => Uint8Array;
};
export type WasmEngineConfig = {
    resourcesPath?: string;
    wasmPath?: string;
    wasmBinary?: Uint8Array;
    loaderCode?: string;
    workerModulesCode?: string;
    loaderModuleName?: string;
    callbacks?: WasmEngineCallbacks;
    enableLogs?: boolean;
    options?: {
        heartbeatInterval?: number;
        lobbyTimeout?: number;
        maxParticipantsScreenShare?: number;
        maxGroupSizeLongRingtone?: number;
        logLevel?: number;
    };
};
export declare class WasmEngine {
    #private;
    static registerGlobalCallbackListener: (callbackName: string, handler: (data: any) => void) => void;
    static unregisterGlobalCallbackListener: (callbackName: string, handler: (data: any) => void) => void;
    static notifyGlobalCallbackListeners: (callbackName: string, data: any) => void;
    constructor(config?: WasmEngineConfig);
    initialize: () => Promise<void>;
    isInitialized: () => boolean;
    /**
     * Tear the engine down and release the worker pool.
     *
     * Returns a promise that settles once every worker thread has actually exited.
     * `Worker.terminate()` is asynchronous, so the previous fire-and-forget
     * version returned while ~20 threads were still alive, leaving several hundred
     * MB resident. Awaiting it is what makes the memory come back.
     */
    destroy: () => Promise<void>;
    initVoipStack: (selfJid: string, meUserJid: string, selfLid: string) => void;
    waitForVoipStackReady: () => Promise<void>;
    isVoipStackReady: () => boolean;
    startCall: (options: {
        peerJid: string;
        peerPn: string;
        peerList?: string[];
        callId: string;
        isVideo: boolean;
        isLidCall?: boolean;
        isFromDialer?: boolean;
        extraData?: Uint8Array;
    }) => unknown;
    /**
     * Start an ad-hoc / group-bound group call.
     *
     * The WASM owns the group key epoch, SRTP, and relay subscriptions; this only
     * hands it the roster. Needs the self device plus at least two remote
     * participants, split into parallel PN / LID / device-CSV lists (the shape the
     * WASM's `startVoipGroupCall` expects).
     */
    startGroupCall: (options: {
        pnUserJids: string[];
        lidUserJids: string[];
        deviceJidsCsv: string[];
        callId: string;
        isVideo?: boolean;
        groupJid?: string;
    }) => unknown;
    /** Join a group call that is already ringing / ongoing. */
    joinOngoingCall: (options: {
        callId: string;
        callCreatorJid: string;
        initialPeerJid: string;
        pnUserJids: string[];
        lidUserJids: string[];
        deviceJidsCsv: string[];
        hasVideo?: boolean;
        groupJid?: string;
        initialGroupTransactionId?: number;
        callCreatorIsNotContact?: boolean;
        joinAndAccept?: boolean;
    }) => unknown;
    /** Invite (add) a participant to the active group call. */
    inviteToCall: (invitedPnUserJid: string, invitedLidUserJid: string, deviceJids: string[]) => void;
    /** Remove a participant from the active group call. */
    removeCallParticipant: (peerJid: string) => void;
    /** Ask the peer to upgrade the current audio call to video. */
    requestVideoUpgrade: () => void;
    /** Accept an inbound peer's video (mid-call upgrade or group participant video). */
    acceptPeerVideo: (jid: string) => void;
    /** Re-broadcast our own video state to the call. */
    broadcastVideoState: () => void;
    /** Toggle our outgoing video track on/off. */
    setVideoMute: (enable: boolean) => void;
    /** Select which participants' video the relay should forward to us. */
    updateParticipantsRxSubscription: (participantJids: string[], videoQualities: number[]) => void;
    acceptCall: (isMicEnabled?: boolean, isCameraEnabled?: boolean) => void;
    /** Decline the ringing call. */
    rejectCall: () => void;
    /**
     * What the WASM currently believes about the call, or null if it has none.
     *
     * `acceptCall` reports nothing at all, so this is the only way to distinguish
     * "the WASM never registered the offer" from "the WASM registered it and
     * declined to engage".
     */
    getCallInfo: () => unknown;
    /**
     * Names of call-related methods the WASM instance actually exposes.
     *
     * Diagnostic: a missing entry point otherwise looks identical to a call the
     * WASM simply declined to engage, since these functions report nothing.
     */
    callMethodNames: () => string[];
    endCall: (reason?: number, sendTerminate?: boolean) => void;
    setMute: (muted: boolean) => number;
    updateNetworkMedium: (networkMedium: number, networkMtu?: number) => void;
    handleSignalingOffer: (msg: {
        payload: string;
        peerPlatform?: number;
        peerAppVersion?: string;
        epochId?: string;
        timestamp?: string;
        isOffline?: boolean;
        isOfferNotContact?: boolean;
        peerJid: string;
        tcToken?: Uint8Array;
    }) => void;
    handleSignalingMessage: (msg: {
        payload: string;
        peerPlatform?: string | number;
        peerAppVersion?: string;
        epochId?: string;
        timestamp?: string;
        isOffline?: boolean;
        peerJid: string;
        tcToken?: Uint8Array;
    }) => void;
    handleSignalingAck: (msg: {
        payload: string;
        ackError?: string;
        msgType?: string;
        peerJid?: string;
        extraData?: Uint8Array;
    }) => void;
    handleSignalingReceipt: (msg: {
        payload: string;
        peerJid: string;
        tcToken?: Uint8Array;
    }) => void;
    handleOnTransportMessage: (data: Uint8Array, ip: string, port: number) => void;
    updateIceRtt: (rttMs: number, relayIp: string, relayPort: number) => void;
    sendAudioData: (data: Float32Array, ptr: number) => void;
    malloc: (size: number) => number;
    free: (ptr: number) => void;
}
export default WasmEngine;
