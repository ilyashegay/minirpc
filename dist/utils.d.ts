export type Request<T extends unknown[] = unknown[]> = {
    id: number;
    method: string;
    params: T;
};
type ResultResponse<T = unknown> = {
    id: number;
    result: T;
};
type ErrorResponse = {
    id: number;
    error: unknown;
};
type EventMessage<T> = {
    event: T;
};
export type Response = ResultResponse | ErrorResponse;
export type ServerMessage<T = unknown> = Response | EventMessage<T>;
export type SocketData = string | ArrayBuffer | ArrayBufferView;
export type ServerRoutes = Record<string, (...args: any[]) => any>;
export type ClientRoutes<R extends ServerRoutes = ServerRoutes> = {
    [key in keyof R]: (...args: Parameters<R[key]>) => Promise<Awaited<ReturnType<R[key]>>>;
};
export declare function invariant(condition: unknown, message?: string): asserts condition;
export declare function makeMessageParser(): (data: SocketData, isBinary: boolean) => Request | ServerMessage | 'heartbeat' | undefined;
export declare function makeMessageSender(send: (data: SocketData) => void): (message: Request | ServerMessage) => void;
export declare function stringifySimple(value: unknown): string;
export {};
