export type DevalueTransforms = Record<string, [
    (value: unknown) => unknown,
    (value: any) => unknown
]>;
export type ClientMessage = {
    id: number;
    method: string;
    params: unknown[];
};
export type ServerMessage = {
    id: number;
    result: unknown;
} | {
    id: number;
    error: unknown;
};
export type SocketData = string | ArrayBuffer | ArrayBufferView;
export type ServerRoutes = Record<string, (...args: any[]) => any>;
export type ClientRoutes<R extends ServerRoutes = ServerRoutes> = {
    [key in keyof R]: (...args: Parameters<R[key]>) => ObservablePromise<Awaited<ReturnType<R[key]>>>;
};
export type ObservablePromise<T> = Promise<T> & (T extends ReadableStream<infer R> ? {
    subscribe: (observer: (value: R) => void, signal?: AbortSignal) => Promise<void>;
} : Record<string, never>);
export declare function invariant(condition: unknown, message?: string): asserts condition;
export declare function makeMessenger(send: (data: SocketData, enqueue?: boolean) => void, signal: AbortSignal, transforms?: DevalueTransforms): {
    parse: (data: SocketData) => ClientMessage | ServerMessage | 'heartbeat' | undefined;
    send: (message: ClientMessage | ServerMessage) => void;
};
