export type Request<T extends unknown[] = unknown[]> = {
    id: number;
    method: string;
    params: T;
};
export type ResultResponse<T = unknown> = {
    id: number;
    result: T;
};
export type ErrorResponse = {
    id: number;
    error: unknown;
};
export type EventMessage<T> = {
    event: T;
};
export type Response = ResultResponse | ErrorResponse;
export type ServerMessage<T> = Response | EventMessage<T>;
export type UnsafeRouter = Record<string, (...args: any[]) => any>;
export type SafeRouter<R extends UnsafeRouter = UnsafeRouter> = {
    [key in keyof R]: (...args: Parameters<R[key]>) => Promise<Awaited<ReturnType<R[key]>>>;
};
export declare class RPCClientError extends Error {
}
type Observer<T> = (value: T) => void;
export declare class Observable<T> {
    private observers;
    subscribe(observer: Observer<T>): void;
    next(value: T): void;
}
export declare class MiniSignal<T> {
    #private;
    static resolve<T>(value: T): MiniSignal<T>;
    resolve(value: T): void;
    then(handler: (value: T) => void): void;
    get promise(): Promise<T>;
}
export declare function asyncForEach<T>(iterable: AsyncIterable<T> | ReadableStream<T>, handle: (value: T) => PromiseLike<void> | void): Promise<void>;
export declare function invariant(condition: unknown, message?: string): asserts condition;
export declare function sleep(ms: number): MiniSignal<void>;
export declare function makeMessageParser(): (data: string | Uint8Array, isBinary: boolean) => Request | ServerMessage<unknown> | 'heartbeat' | undefined;
export declare function makeMessageSender<T>(send: (data: string | Uint8Array) => void): (message: T) => void;
export declare function stringifySimple(value: unknown): string;
export {};
