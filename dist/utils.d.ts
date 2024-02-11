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
    [key in keyof R]: (...args: Parameters<R[key]>) => Result<Awaited<ReturnType<R[key]>>>;
};
export type Result<T> = Promise<T> & (T extends ReadableStream<infer R> ? {
    subscribe: (observer: (value: R) => unknown, options?: {
        signal?: AbortSignal;
        onError?: (error: unknown) => void;
    }) => void;
} : Record<string, never>);
export declare function isClientMessage(message: Record<string, unknown>): message is ClientMessage;
export declare function isServerMessage(message: Record<string, unknown>): message is ServerMessage;
export declare function invariant(condition: unknown, message?: string): asserts condition;
export declare function createTransport(send: (data: SocketData) => void, transforms?: DevalueTransforms): {
    parse: (data: SocketData) => ClientMessage | ServerMessage | undefined;
    send: (message: ClientMessage | ServerMessage) => void;
    close(reason?: string | Error): void;
    getTimeUntilExpectedExpiry(interval: number): number;
    ping(latency: number, onResult: (alive: boolean) => void): void;
};
