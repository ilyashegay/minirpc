/// <reference types="node" />
import { type ClientRoutes, type ServerRoutes, type DevalueTransforms, type SocketData } from './utils.js';
export { type DevalueTransforms };
export declare class RPCClientError extends Error {
}
export type Server = ReturnType<typeof createServer>;
export type Context<T> = {
    get(): T;
    set(value: T): void;
    update(updateFn: (value: T) => T): void;
};
type Ware = {
    use(fn: () => void): Ware;
    routes<R extends ServerRoutes>(routes: R): ClientRoutes<R>;
};
export declare function createServer(options: {
    heartbeat?: {
        interval?: number;
        latency?: number;
    };
    transforms?: DevalueTransforms;
    onError: (error: unknown) => void;
}): {
    router: <R extends ServerRoutes>(routes: R) => ClientRoutes<R>;
    use: (fn: () => void) => Ware;
    init: () => (client: {
        key: WeakKey;
        send: (data: SocketData) => void;
        terminate(): void;
    }) => {
        message: (data: SocketData) => void;
        close: (code: number, reason: string | Buffer) => void;
    };
};
export declare function createChannel<T, P extends unknown[] = []>(onSubscribe?: (...args: P) => T | Promise<T>, onUnsubscribe?: () => unknown): {
    readonly size: number;
    push: (payload: T) => void;
    pull: (...args: P) => ReadableStream<T>;
};
export declare function getContextKey(): WeakKey;
export declare function createContext<T = undefined>(): (key?: WeakKey) => Context<T | undefined>;
export declare function createContext<T>(initialValue: T): (key?: WeakKey) => Context<T>;
