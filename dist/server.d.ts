/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { type ClientRoutes, type ServerRoutes, type DevalueTransforms } from './utils.js';
export { type DevalueTransforms };
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
    onRequest?: http.RequestListener;
    onUpgrade?: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => number | undefined | Promise<number | undefined>;
    onConnection?: (connection: Connection<T>) => ((event: {
        code: number;
        reason: string;
    }) => void) | undefined;
};
export declare function createServer<T>(onError: (error: unknown) => void, transforms?: DevalueTransforms): {
    router: <Routes extends ServerRoutes>(routes: Routes) => ClientRoutes<Routes>;
    broadcast: (event: T) => void;
    listen: (options?: Options<T>) => Promise<void>;
};
