import { type SocketData } from './utils.js';
export type StreamChunkMeta = {
    id: number;
    length: number;
    binary: boolean;
};
export type StreamMessage = {
    id: number;
    stream: 'cancel';
} | (StreamChunkMeta & {
    stream: 'chunk';
    index: number;
}) | {
    id: number;
    stream: 'done';
    count: number;
    length: number;
} | {
    id: number;
    stream: 'error';
    error: string;
};
export declare function makeStreamTransport(send: (message: StreamMessage, chunk?: SocketData) => void): {
    abort: (reason: unknown) => void;
    reduce: (value: unknown) => number | undefined;
    revive: (id: number) => ReadableStream<SocketData>;
    receiveChunk: (data: SocketData, meta: StreamChunkMeta) => void;
    receiveMessage: (message: StreamMessage) => StreamChunkMeta | undefined;
};
