/// <reference types="node" />
/// <reference types="node" />
import http from 'node:http';
import WebSocket from 'ws';
import { type ClientRoutes, type ServerRoutes } from './utils.js';
export declare class RPCClientError extends Error {
}
export type Connection<T> = {
    send: (event: T) => void;
    close: (code?: number, data?: string | Buffer) => void;
    terminate: () => void;
};
export type Options<T> = {
    port?: number;
    signal?: AbortSignal;
    heartbeat?: number;
    authenticate?: (request: http.IncomingMessage) => boolean;
    onRequest?: http.RequestListener;
    onConnection?: (connection: Connection<T>) => ((event: WebSocket.CloseEvent) => void) | undefined;
};
export declare function createServer<T>(onError: (error: unknown) => void): {
    router: <Routes extends ServerRoutes>(routes: Routes) => ClientRoutes<Routes>;
    broadcast: (event: T) => void;
    listen: (options?: Options<T>) => Promise<void>;
};
