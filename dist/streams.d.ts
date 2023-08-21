import { type SocketData } from './utils.js';
export type StreamChunkMeta = {
    id: number;
    length: number;
    binary: boolean;
};
export type StreamMessage = {
    stream: 'cancel';
    id: number;
} | ({
    stream: 'chunk';
    index: number;
} & StreamChunkMeta) | {
    stream: 'done';
    id: number;
    count: number;
    length: number;
} | {
    stream: 'error';
    id: number;
    error: string;
};
export declare function makeStreamTransport(send: (message: StreamMessage, chunk?: SocketData) => void): {
    abort: (reason: unknown) => void;
    reduce: (value: unknown) => number | undefined;
    revive: (id: number) => ReadableStream<SocketData>;
    receiveChunk: (data: SocketData, meta: StreamChunkMeta) => void;
    receiveMessage: (message: StreamMessage) => StreamChunkMeta | undefined;
};
