export { createRPCClient, createRPCClientStream, RPCClientError, type SafeRouter, controlledDuplex, asyncForEach, Observable, } from './utils.js';
export type WebSocketStreamOptions = {
    protocols?: string[];
    signal?: AbortSignal;
    onerror?: (error: unknown) => void;
};
type WebSocketStreamConnection = {
    protocol: string;
    extensions: string;
    closed: Promise<CloseEvent>;
};
export declare class WebSocketStreamette<T extends Uint8Array | string = Uint8Array | string> {
    readonly url: string;
    readonly opened: AsyncIterable<WebSocketStreamConnection>;
    readonly readable: ReadableStream<T>;
    readonly writable: WritableStream<T>;
    constructor(url: string, options?: WebSocketStreamOptions);
}
