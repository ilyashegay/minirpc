/// <reference types="node" />
/// <reference types="node" />
import http from 'node:http';
import WebSocket from 'ws';
import { type SafeRouter, type UnsafeRouter } from './utils.js';
export * from './utils.js';
export type Connection<T> = {
    send(event: T): void;
    close(code?: number, data?: string | Buffer): void;
    terminate(): void;
};
export declare function createServer<T>(onError: (error: unknown) => void): {
    router: <Router extends UnsafeRouter>(router: Router) => SafeRouter<Router>;
    broadcast: (event: T) => void;
    listen: (options: {
        port?: number | undefined;
        signal?: AbortSignal | undefined;
        authenticate?: ((request: http.IncomingMessage) => boolean) | undefined;
        onRequest?: http.RequestListener<typeof http.IncomingMessage, typeof http.ServerResponse> | undefined;
        onConnection: (connection: Connection<T>) => ((event: WebSocket.CloseEvent) => void) | undefined;
    }) => Promise<void>;
};
