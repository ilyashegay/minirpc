type Request<T extends unknown[] = unknown[]> = {
    id: number;
    method: string;
    params: T;
};
type ResultResponse<T = unknown> = {
    id: number;
    method: string;
    result: T;
};
type ErrorResponse = {
    id: number;
    method: string;
    error: unknown;
};
type EventMessage<T> = {
    event: T;
};
type ServerMessage<T> = ResultResponse | ErrorResponse | EventMessage<T>;
type UnsafeRouter = Record<string, (...args: any[]) => any>;
export type SafeRouter<R extends UnsafeRouter = UnsafeRouter> = {
    [key in keyof R]: (...args: Parameters<R[key]>) => Promise<Awaited<ReturnType<R[key]>>>;
};
export declare class RPCClientError extends Error {
}
export declare function createRPCClient<T, Router extends SafeRouter>(): {
    router: Router;
    message: (msg: ServerMessage<T> | string) => void;
    events: Observable<T>;
    requests: Observable<Request<unknown[]>>;
};
export declare function createRPCClientStream<T, Router extends SafeRouter>(): {
    router: Router;
    events: Observable<T>;
    readable: ReadableStream<string | Uint8Array>;
    writable: WritableStream<string>;
};
export declare function createRPCServer(): {
    router: <Router extends UnsafeRouter>(router: Router) => SafeRouter<Router>;
    message: (req: Request | string, callback: (response: ResultResponse | ErrorResponse, error?: unknown) => void) => void;
};
type EventSource<T> = (publish: (data: T) => void) => {
    subscribe(): T;
    unsubscribe(): void;
};
export declare function createRPCServerStream<T>(options: {
    eventSource: EventSource<T>;
    onerror?: (error: unknown) => void;
}): {
    router: <Router extends UnsafeRouter>(router: Router) => SafeRouter<Router>;
    connect: () => TransformStream<string | Uint8Array, string>;
};
export declare function controlledDuplex<I, O>(transformer?: Transformer<I, O>, writableStrategy?: QueuingStrategy<I>, readableStrategy?: QueuingStrategy<O>): {
    controller: TransformStreamDefaultController<O>;
    readable: ReadableStream<O>;
    writable: WritableStream<I>;
};
export declare function asyncForEach<T>(iterable: AsyncIterable<T> | ReadableStream<T>, handle: (value: T) => Promise<void> | void): Promise<void>;
type Observer<T> = (value: T) => void;
export declare class Observable<T> {
    private observers;
    subscribe(observer: Observer<T>): void;
    next(value: T): void;
}
export declare class StrictMap<K, V> extends Map<K, V> {
    private initializer;
    constructor(initializer?: ((key: K) => V) | string);
    get(key: K): V;
}
export type Future<T> = {
    resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0];
    reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1];
};
export declare class Deferred<T> {
    resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0];
    reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1];
    promise: Promise<T>;
}
export declare class MiniSignal<T> {
    #private;
    static resolve<T>(value: T): MiniSignal<T>;
    resolve(value: T): void;
    then(handler: (value: T) => void): void;
}
export declare class EtherealValue<T> {
    #private;
    then(handler: (value: T) => void): void;
    set(value: T): void;
    reset(): void;
}
export declare function invariant(condition: unknown, message?: string): asserts condition;
export {};
