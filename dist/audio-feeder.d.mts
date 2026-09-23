export declare class AudioFeeder {
    #private;
    private readonly sampleRate;
    private readonly channels;
    private readonly framesPerChunk;
    private readonly onChunk;
    private readonly source;
    droppedChunks: number;
    underflowChunks: number;
    bytesProduced: number;
    chunksEmitted: number;
    bytesWritten: number;
    /** True when audio is pushed in with `write()` rather than read from a source. */
    get isStreaming(): boolean;
    /** Chunks waiting to go out. */
    get queuedChunks(): number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: string);
    start: () => void;
    stop: () => void;
    /**
     * Push raw PCM in the format declared by a `stream:` source.
     *
     * Input is downmixed to mono if needed and resampled to the call's capture
     * rate. Returns false when there is no stream source or the feeder is stopped.
     */
    write: (chunk: Uint8Array | Buffer) => boolean;
    /** Signal end of input on a stream source. */
    endInput: () => void;
    /**
     * Drop audio that has not been sent to the call yet, and return how many
     * chunks were discarded.
     *
     * Used for barge-in: the outbound queue holds up to MAX_QUEUED_CHUNKS frames
     * (about 20 seconds at 20 ms per frame), so without this the previous turn
     * would keep playing long after the peer interrupted. For stream sources this
     * clears everything, including partially resampled audio.
     */
    flush: () => number;
}
