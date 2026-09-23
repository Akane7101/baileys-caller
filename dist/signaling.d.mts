/**
 * Signaling bridge.
 *
 * Glues the WASM VoIP stack to Baileys: encrypts outbound `offer` / `enc_rekey`
 * stanzas, decrypts inbound ones, manages TC tokens, multi-device JID routing,
 * and signal-session refresh.
 *
 * @author ShellTear
 */
export type BaileysSocket = {
    authState: any;
    signalRepository: any;
    generateMessageTag: () => string;
    query: (node: any) => Promise<any>;
    sendNode: (node: any) => Promise<void>;
    waitForMessage: (tag: string, timeoutMs: number) => Promise<any>;
    getUSyncDevices: (jids: string[], ignoreZeroDevices: boolean, forceQuery: boolean) => Promise<any[]>;
    presenceSubscribe: (jid: string) => Promise<void>;
    ws: any;
    ev: any;
};
export type SignalingBridgeConfig = {
    sock: BaileysSocket;
};
export declare class SignalingBridge {
    #private;
    constructor(config: SignalingBridgeConfig);
    /** Hand the WASM engine in so we can dispatch ack callbacks back to it. */
    attachEngine: (voip: any) => void;
    init: () => Promise<void>;
    sendSignaling: (peerJid: string, callId: string, xmlPayload: Uint8Array) => void;
    /**
     * Queue an inbound `<call>` node for delivery to the WASM.
     *
     * Returns the queue promise: processing is serialised and can take seconds (a
     * tc-token fetch alone allows up to TC_TOKEN_REQUEST_TIMEOUT_MS), and an
     * inbound offer cannot be accepted before the WASM has actually received it.
     */
    processIncomingCall: (node: any, voip: any, activeCallId: string) => Promise<void>;
    processIncomingReceipt: (node: any, voip: any, activeCallId: string) => void;
    requestTcToken: (jid: string) => Promise<Uint8Array | undefined>;
    ensureTcToken: (...jids: string[]) => Promise<Uint8Array | undefined>;
    discoverPeerDevices: (peerLidJid: string) => Promise<string[]>;
    /**
     * Resolve one group-call target into the parallel wire lists the WASM's
     * `startVoipGroupCall` / `joinVoipOngoingCall` expect: its PN JID, LID JID,
     * and a comma-separated list of its device JIDs.
     */
    resolveGroupParticipant: (pnJid: string) => Promise<{
        pn: string;
        lid: string;
        deviceCsv: string;
    } | null>;
    ensureSessionsForPeers: (jids: string[]) => Promise<void>;
    resolveLid: (pnJid: string) => Promise<string | undefined>;
    issueTcToken: (jid: string) => Promise<boolean>;
    getRemoteDeviceJid: (callId: string) => string | undefined;
}
