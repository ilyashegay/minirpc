import * as ws from 'ws';
export { createRPCServer, createRPCServerStream, RPCClientError, type SafeRouter, controlledDuplex, asyncForEach, Observable, } from './utils.js';
export declare class WebSocketClient<T extends Uint8Array | string = Uint8Array | string> {
    readonly readable: ReadableStream<T>;
    readonly writable: WritableStream<T>;
    readonly closed: Promise<{
        code?: number;
        reason?: string;
    }>;
    constructor(ws: ws.WebSocket);
}
export declare function listen<T extends Uint8Array | string = Uint8Array | string>(options: ws.ServerOptions, onConnection: (socket: WebSocketClient<T>) => unknown): void;
