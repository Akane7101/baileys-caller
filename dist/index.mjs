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
import { RelayRtcTransport } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState } from "./types.mjs";
export { CallState } from "./types.mjs";
const SHA256_LEN = 32;
const loadBaileys = async () => {
    try {
        return await import("@whiskeysockets/baileys");
    }
    catch {
        throw new Error("Could not import @whiskeysockets/baileys. Install it as a peer dependency.");
    }
};
const toBareJid = (jid) => {
    if (!jid)
        return jid;
    const at = jid.indexOf("@");
    if (at < 0)
        return jid;
    const user = jid.slice(0, at).split(":")[0];
    return `${user}@${jid.slice(at + 1)}`;
};
const computeHkdf = (key, salt, info, length) => {
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
const computeHmacSha256 = (data, key) => {
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
/**
 * Inbound accept timing.
 *
 * The WASM buffers an inbound offer and only promotes it to an active call once
 * the relay-latency exchange has completed. `acceptCall()` on a buffered call
 * fails with "call not active" (status 670007) and raises a CALL_ACCEPT_FAILED
 * event, so we must wait for the call to go active before accepting — the same
 * ordering meowcaller uses (offer -> preaccept -> relaylatency -> accept).
 */
const ACCEPT_POLL_MS = 250;
const ACCEPT_WAIT_MS = 20_000;
const isCallReceiptNode = (node) => {
    if (node?.tag !== "receipt")
        return false;
    const child = Array.isArray(node.content) ? node.content[0] : null;
    return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};
/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
    callId;
    engine;
    #state = CallState.Idle;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #hangupTimer = null;
    #ended = false;
    /**
     * Set by `end()`. Kept separate from `#ended` so a local hangup does not
     * suppress the `ended` event: marking the call ended here used to make the
     * subsequent `_forceEnd` a no-op, so `ended` never fired and `waitForEnd()`
     * never settled.
     */
    #endRequested = false;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource = "silence";
    /** @internal set by VoipClient; resolves the live feeder at call time */
    _writeAudio = null;
    /** @internal set by VoipClient */
    _clearAudio = null;
    /** @internal set by VoipClient for a ringing inbound call */
    _answer = null;
    /** @internal set by VoipClient for a ringing inbound call */
    _reject = null;
    /** True for a call the peer placed to us. */
    incoming;
    /** The peer, as reported by the offer. */
    peerJid = "";
    constructor(callId, engine, durationMs, incoming = false) {
        super();
        this.incoming = incoming;
        this.callId = callId;
        this.engine = engine;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
        if (durationMs > 0) {
            this.#endTimer = setTimeout(() => this.end("timeout"), durationMs);
        }
    }
    get state() { return this.#state; }
    /**
     * Hang up. Idempotent.
     *
     * The WASM normally reports `Ending`/`Idle` straight after, which is what
     * emits `ended`. A fallback timer resolves anyway if that report never
     * arrives, so `waitForEnd()` cannot hang forever.
     */
    end = (reason = "hangup") => {
        if (this.#ended || this.#endRequested)
            return;
        this.#endRequested = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        try {
            this.engine.endCall(0, true);
        }
        catch { }
        this.#hangupTimer = setTimeout(() => this._forceEnd(reason), HANGUP_CONFIRM_MS);
        if (this.#hangupTimer.unref)
            this.#hangupTimer.unref();
    };
    mute = (muted) => {
        try {
            this.engine.setMute(muted);
        }
        catch { }
    };
    /**
     * Answer a ringing inbound call.
     *
     * `audioSource` behaves exactly as it does for an outbound call, including
     * the `stream:` form for live audio. Only meaningful while ringing.
     */
    answer = (opts = {}) => {
        if (!this.incoming)
            throw new Error("answer() is only for incoming calls");
        this._answer?.(opts);
    };
    /** Decline a ringing inbound call. */
    reject = () => {
        if (!this.incoming)
            throw new Error("reject() is only for incoming calls; use end()");
        this._reject?.();
    };
    /**
     * Push uplink audio into a call opened with a `stream:` audioSource.
     *
     * The PCM must match the format declared in that source, e.g.
     * `audioSource: "stream:s16le@24000"` for the Live API's 24 kHz output.
     * Returns false when the call has no stream source or is not capturing yet.
     */
    writeAudio = (chunk) => this._writeAudio?.(chunk) ?? false;
    /**
     * Drop uplink audio that has not played yet, and return how many frames were
     * discarded. Call this on a barge-in so the previous turn stops immediately.
     */
    clearAudio = () => this._clearAudio?.() ?? 0;
    waitForEnd = () => this.#endPromise;
    /** True once the WASM has reported any state for this call. */
    _sawWasmState = false;
    /** True once acceptCall has been issued for this (active) call. */
    _accepted = false;
    /** Whether this call has already finished. */
    get ended() { return this.#ended; }
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState = (state) => {
        this._sawWasmState = true;
        this.#state = state;
        if (state === CallState.PreacceptReceived)
            this.emit("ringing");
        else if (state === CallState.Active)
            this.emit("connected");
        else if (state === CallState.Idle || state === CallState.Ending) {
            this._forceEnd("ended");
        }
    };
    /** @internal */
    _emitAudio = (pcm) => { this.emit("audio", pcm); };
    /** @internal */
    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        if (this.#hangupTimer) {
            clearTimeout(this.#hangupTimer);
            this.#hangupTimer = null;
        }
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
    #config;
    #engine = null;
    #relay = null;
    #signaling = null;
    #sock = null;
    #activeCall = null;
    #baileys = null;
    // Capture state populated when WASM negotiates audio params
    #capturePtr = 0;
    #captureChunkBytes = 0;
    #captureSampleRate = 16000;
    #captureChannels = 1;
    #captureFramesPerChunk = 320;
    #feeder = null;
    /** Calls already seen, so a re-sent offer does not ring twice. */
    #seenIncomingCallIds = new Set();
    /** WASM call-event types already logged, to keep the diagnostic quiet. */
    #seenEventTypes = new Set();
    constructor(config) {
        super();
        this.#config = config;
    }
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect = async () => {
        this.#baileys = await loadBaileys();
        const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
        const makeSocket = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;
        const authDir = resolve(this.#config.authDir);
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const silentLogger = {
            level: "silent",
            child: () => silentLogger,
            trace: () => { },
            debug: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            fatal: () => { },
        };
        const createSocket = () => makeSocket({
            auth: state,
            emitOwnEvents: true,
            logger: silentLogger,
        });
        // Connect with auto-reconnect on the post-QR 515 stream-error path.
        //
        // The 515 handling needs a process-level hook because baileys throws it
        // outside any promise chain, but it must not cost the host application
        // its own crash guard: the previous `process.removeAllListeners` wiped
        // every pre-existing uncaughtException handler permanently, so an
        // embedding app silently lost its safety net (and died on the next
        // unrelated throw). Instead, detach the host's handlers for the duration
        // of the connect and put them back afterwards.
        const hostExceptionHandlers = process.listeners("uncaughtException");
        let ownExceptionHandler = null;
        const restoreHostExceptionHandlers = () => {
            if (ownExceptionHandler) {
                process.removeListener("uncaughtException", ownExceptionHandler);
                ownExceptionHandler = null;
            }
            for (const handler of hostExceptionHandlers) {
                if (!process.listeners("uncaughtException").includes(handler)) {
                    process.on("uncaughtException", handler);
                }
            }
        };
        try {
            await new Promise((resolveOpen, rejectOpen) => {
            let opened = false;
            let retries = 0;
            const maxRetries = 5;
            const connectSocket = () => {
                this.#sock = createSocket();
                this.#sock.ev.on("creds.update", saveCreds);
                for (const handler of hostExceptionHandlers) {
                    process.removeListener("uncaughtException", handler);
                }
                if (ownExceptionHandler)
                    process.removeListener("uncaughtException", ownExceptionHandler);
                ownExceptionHandler = (err) => {
                    const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
                    if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
                        retries += 1;
                        setTimeout(connectSocket, 1500);
                    }
                    else if (!opened) {
                        rejectOpen(err);
                    }
                    else {
                        // Past open: this is the host's problem again, not ours.
                        for (const handler of hostExceptionHandlers) {
                            try {
                                handler(err);
                            }
                            catch { }
                        }
                    }
                };
                process.on("uncaughtException", ownExceptionHandler);
                this.#sock.ev.on("connection.update", (update) => {
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
                        const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
                        if (shouldReconnect && retries < maxRetries) {
                            retries += 1;
                            setTimeout(connectSocket, 1000);
                        }
                        else {
                            rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
                        }
                    }
                });
            };
            connectSocket();
            });
        }
        finally {
            restoreHostExceptionHandlers();
        }
        this.#signaling = new SignalingBridge({ sock: this.#sock });
        await this.#signaling.init();
        this.#relay = new RelayRtcTransport({
            onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
            onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
        });
        // VOIP_WASM_LOG=1 surfaces the WASM's own internal logs, filtered to the
        // call-setup lines. This is how the WASM's reason for rejecting an
        // inbound offer becomes visible: the reject decision (event 92) is
        // logged inside `preprocess_offer` with a human-readable reason that is
        // otherwise dropped, because nothing wired `onLog`. Unfiltered WASM debug
        // output is a firehose, so a keyword filter keeps it to what matters.
        const wasmLogEnabled = process.env.VOIP_WASM_LOG === "1";
        const wasmLogVerbose = process.env.VOIP_WASM_LOG === "2";
        const CALL_LOG_RE = /offer|reject|reason|preprocess|pending|contact|accept|missed|expired|silence|terminat|relay|call.?state|not.?authoriz|privacy/i;
        this.#engine = new WasmEngine({
            options: { logLevel: wasmLogEnabled || wasmLogVerbose ? 4 : 3 },
            callbacks: {
                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),
                onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
                sendDataToRelay: (data, ip, port) => this.#relay.send(data, ip, port),
                onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
                onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
                onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
                onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
                onLog: (level, message) => {
                    if (!wasmLogEnabled && !wasmLogVerbose)
                        return;
                    if (wasmLogVerbose || level === "error" || level === "warn" || CALL_LOG_RE.test(message)) {
                        console.log(`[voip-wasm:${level}] ${String(message).slice(0, 400)}`);
                    }
                },
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
        try {
            this.#engine.updateNetworkMedium(2, 0);
        }
        catch { }
        this.#sock.ws.on("CB:call", (node) => {
            // The WASM must have the offer before it can be accepted, and delivery
            // is queued and can take seconds. Surfacing the call earlier meant
            // answer() reached a WASM that had never heard of the call, so
            // acceptCall() was a silent no-op — the call logged as answered and
            // then just rang out.
            const delivered = this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");
            void delivered
                .then(() => this.#handleIncomingOffer(node))
                .catch((err) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
        });
        this.#sock.ws.on("CB:receipt", (node) => {
            if (!isCallReceiptNode(node))
                return;
            this.#signaling.processIncomingReceipt(node, this.#engine, this.#activeCall?.callId ?? "");
        });
    };
    /** Place an outbound voice call. */
    call = async (phoneNumber, opts = {}) => {
        if (!this.#engine || !this.#signaling)
            throw new Error("Not connected. Call connect() first.");
        if (this.#activeCall)
            throw new Error("A call is already active.");
        const targetNumber = phoneNumber.replace(/\D/g, "");
        const targetPnJid = `${targetNumber}@s.whatsapp.net`;
        // No auto-hangup by default. The old default of 120_000 silently ended
        // every call after two minutes, which reads as a bug to callers who
        // never asked for a duration. Pass durationMs explicitly to opt in.
        const durationMs = opts.durationMs ?? 0;
        const audioSource = opts.audioSource ?? "silence";
        const peerLid = await this.#signaling.resolveLid(targetPnJid);
        if (!peerLid)
            throw new Error(`Could not resolve LID for ${targetPnJid}`);
        for (const jid of [targetPnJid, peerLid]) {
            try {
                await this.#sock.presenceSubscribe(jid);
            }
            catch { }
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
    /** Tear down the WhatsApp socket and release resources. */
    disconnect = async () => {
        this.#activeCall?._forceEnd("disconnect");
        this.#activeCall = null;
        this.#feeder?.stop?.();
        this.#feeder = null;
        this.#relay?.closeAll();
        const engine = this.#engine;
        this.#engine = null;
        this.#relay = null;
        this.#signaling = null;
        try {
            this.#sock?.end?.();
        }
        catch { }
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
     * already active."; it also stops the feeder, which otherwise leaks an
     * ffmpeg process when a call ends without a WASM capture-stop report.
     */
    #registerCall = (call) => {
        // Resolved lazily: the feeder only exists once the WASM starts capturing.
        call._writeAudio = (chunk) => this.#feeder?.write(chunk) ?? false;
        call._clearAudio = () => this.#feeder?.flush() ?? 0;
        this.#activeCall = call;
        call.once("ended", () => {
            if (this.#activeCall === call)
                this.#activeCall = null;
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
    #handleIncomingOffer = (node) => {
        const { getBinaryNodeChild, getAllBinaryNodeChildren } = this.#baileys;
        const offer = getBinaryNodeChild(node, "offer");
        if (!offer)
            return;
        const callId = String(offer.attrs?.["call-id"] ?? "");
        if (!callId || this.#seenIncomingCallIds.has(callId))
            return;
        // An offer-shaped "call ended" notification is not a live call; engaging
        // it earns an accept error from the server.
        if (offer.attrs?.is_call_ended === "1" || offer.attrs?.terminate_reason)
            return;
        this.#seenIncomingCallIds.add(callId);
        if (this.#seenIncomingCallIds.size > 256) {
            this.#seenIncomingCallIds.delete(this.#seenIncomingCallIds.values().next().value);
        }
        const peerJid = String(offer.attrs?.["call-creator"] ?? node.attrs?.from ?? "");
        const children = getAllBinaryNodeChildren(offer) ?? [];
        const isVideo = children.some((c) => c.tag === "video");
        const isGroup = !!offer.attrs?.["group-jid"] || children.some((c) => c.tag === "group_info");
        const call = new ActiveCall(callId, this.#engine, 0, true);
        call.peerJid = peerJid;
        // Only one call can be up at a time: the WASM holds a single call context.
        if (this.#activeCall) {
            try {
                this.#engine?.rejectCall();
            }
            catch { }
            call._forceEnd("busy");
            return;
        }
        call._answer = ({ audioSource = "silence", withMic = true }) => {
            call._audioSource = audioSource;
            // The WASM buffers the offer and reports no active call (getCallInfo
            // status 670007) until the relay-latency handshake it drives
            // internally finishes. Accepting before then fails and tears the call
            // down. So poll until the call goes active, then accept exactly once.
            // Incoming signaling (relaylatency/transport) keeps being fed to the
            // WASM meanwhile, which is what advances the call to active.
            const deadline = Date.now() + ACCEPT_WAIT_MS;
            let logged = false;
            const waitThenAccept = () => {
                if (call.ended || this.#activeCall !== call || call._accepted)
                    return;
                let info;
                try {
                    info = this.#engine.getCallInfo();
                }
                catch { }
                const active = typeof info === "string"
                    ? info.trim().length > 0 && !info.startsWith("getCallInfo threw")
                    : !!info;
                if (active) {
                    call._accepted = true;
                    console.log(`[baileys-caller] call ${call.callId} is active; accepting now`);
                    try {
                        this.#engine.acceptCall(withMic, false);
                    }
                    catch (err) {
                        this.emit("error", err instanceof Error ? err : new Error(String(err)));
                        call._forceEnd("answer_failed");
                    }
                    return;
                }
                if (Date.now() > deadline) {
                    console.log(`[baileys-caller] call ${call.callId} never became active within ${ACCEPT_WAIT_MS}ms; giving up`);
                    call._forceEnd("accept_timeout");
                    return;
                }
                if (!logged) {
                    logged = true;
                    console.log(`[baileys-caller] answer requested for ${call.callId}; waiting for the call to go active before accepting`);
                }
                const t = setTimeout(waitThenAccept, ACCEPT_POLL_MS);
                if (t.unref)
                    t.unref();
            };
            waitThenAccept();
        };
        call._reject = () => {
            try {
                this.#engine.rejectCall();
            }
            catch { }
            call._forceEnd("rejected");
        };
        this.#registerCall(call);
        console.log(`[baileys-caller] incoming call ${callId} from ${peerJid}` +
            `${isVideo ? " (video)" : ""}${isGroup ? " (group)" : ""}`);
        // Nothing listening means nobody can answer, and an unanswered offer
        // just rings out — decline it explicitly instead.
        if (this.listenerCount("incoming") === 0) {
            call._reject?.();
            return;
        }
        this.emit("incoming", call, { isVideo, isGroup, peerJid });
    };
    // ─── private ──────────────────────────────────────────────────────────────
    #handleCallEvent = (eventType, eventData) => {
        // Only three event types are acted on. During an inbound call the useful
        // question is what the WASM reported at all, so anything unrecognised is
        // logged once per type instead of being dropped in silence.
        if (eventType !== 16 && eventType !== 156 && eventType !== 2 && !this.#seenEventTypes.has(eventType)) {
            this.#seenEventTypes.add(eventType);
            console.log(`[baileys-caller] unhandled WASM call event ${eventType}:`, String(eventData ?? "").slice(0, 300));
        }
        if (eventType === 16 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                const info = parsed.call_info ?? parsed.callInfo ?? {};
                const callState = Number(info.call_state ?? info.callState ?? 0);
                this.#activeCall?._updateState(callState);
            }
            catch { }
        }
        else if (eventType === 156 && eventData) {
            try {
                const update = JSON.parse(eventData);
                this.#relay?.updateRelayList(update);
            }
            catch { }
        }
        else if (eventType === 2) {
            this.#activeCall?._forceEnd("remote_end");
        }
        else if (eventType === WASM_EVENT_CALL_REJECTED) {
            let reason = "unknown";
            try {
                reason = String(JSON.parse(eventData ?? "{}").reason_code ?? "unknown");
            }
            catch { }
            const call = this.#activeCall;
            // This event also fires for a failed accept on a not-yet-active call.
            // If we have not accepted yet, it is setup churn from an earlier
            // build's premature accept path — ignore it and let the call keep
            // progressing. Once we have actually accepted, it is a real rejection.
            if (call && !call.incoming) {
                console.log(`[baileys-caller] the WASM rejected call ${call.callId} (reason ${reason})`);
                call._forceEnd(`wasm_rejected_${reason}`);
            }
            else if (call && call._accepted) {
                console.log(`[baileys-caller] the WASM rejected accepted call ${call.callId} (reason ${reason})`);
                call._forceEnd(`wasm_rejected_${reason}`);
            }
            else {
                console.log(`[baileys-caller] WASM call-rejected event during inbound setup (reason ${reason}); not terminal, still waiting`);
            }
        }
    };
    #handleAudioCaptureInit = (config) => {
        if (!this.#engine)
            return;
        this.#captureSampleRate = config.sampleRate || 16000;
        this.#captureChannels = config.channels || 1;
        this.#captureFramesPerChunk = config.framesPerChunk || 320;
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    };
    #handleAudioCaptureStart = () => {
        if (!this.#engine || !this.#capturePtr)
            return;
        const audioSource = this.#activeCall?._audioSource ?? "silence";
        this.#feeder = new AudioFeeder(this.#captureSampleRate, this.#captureChannels, this.#captureFramesPerChunk, (chunk) => {
            if (this.#engine && this.#capturePtr)
                this.#engine.sendAudioData(chunk, this.#capturePtr);
        }, audioSource);
        this.#feeder.start();
    };
    #handleAudioCaptureStop = () => {
        this.#feeder?.stop();
        this.#feeder = null;
        if (this.#engine && this.#capturePtr) {
            try {
                this.#engine.free(this.#capturePtr);
            }
            catch { }
            this.#capturePtr = 0;
        }
    };
}
