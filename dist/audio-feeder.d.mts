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
    /** Push raw PCM in the format declared by a `stream:` source. */
    write: (chunk: Uint8Array | Buffer) => boolean;
    /** Signal end of input on a stream source. */
    endInput: () => void;
    /** Drop audio not yet sent to the call; returns the number of chunks dropped. */
    flush: () => number;
}
