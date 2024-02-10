/// <reference types="node" />
import { type ClientRoutes, type ServerRoutes, type DevalueTransforms, type SocketData } from './utils.js';
export { type DevalueTransforms };
export declare class RPCClientError extends Error {
}
export type MiniRPCServer = {
    router<R extends ServerRoutes>(routes: R): ClientRoutes<R>;
    run(options: {
        signal?: AbortSignal;
    }): Connector;
};
export type Context<T> = {
    get(): T;
    set(value: T): void;
    update(updateFn: (value: T) => T): void;
};
type Client = {
    key: WeakKey;
    send: (data: SocketData) => void;
    terminate(): void;
};
type Connector = (client: Client) => {
    message: (data: SocketData) => void;
    close: (code: number, reason: string | Buffer) => void;
};
export declare function createServer(options: {
    heartbeat?: number;
    transforms?: DevalueTransforms;
    onError: (error: unknown) => void;
}): MiniRPCServer;
export declare function createChannel<T>(onpull?: (first: boolean) => T): {
    readonly size: number;
    push: (payload: T) => void;
    pull: () => ReadableStream<T>;
};
export declare function getContextKey(): WeakKey;
export declare function createContext<T = undefined>(): (key?: WeakKey) => Context<T | undefined>;
export declare function createContext<T>(initialValue: T): (key?: WeakKey) => Context<T>;
