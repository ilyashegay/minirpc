type ClientMessage = {
    id: number;
    method: string;
    params: unknown[];
};
type ServerMessage = {
    id: number;
    result: unknown;
} | {
    id: number;
    error: unknown;
} | {
    event: unknown;
};
export type SocketData = string | ArrayBuffer | ArrayBufferView;
export type ServerRoutes = Record<string, (...args: any[]) => any>;
export type ClientRoutes<R extends ServerRoutes = ServerRoutes> = {
    [key in keyof R]: (...args: Parameters<R[key]>) => Promise<Awaited<ReturnType<R[key]>>>;
};
export declare function invariant(condition: unknown, message?: string): asserts condition;
export declare function stringifySimple(value: unknown): string;
export declare function makeServerMessenger(send: (data: SocketData, enqueue?: boolean) => void, signal: AbortSignal): {
    parse: (data: SocketData) => ClientMessage | 'heartbeat' | undefined;
    send: (message: ServerMessage) => void;
};
export declare function makeClientMessenger(send: (data: SocketData, enqueue?: boolean) => void): {
    parse(data: SocketData): ServerMessage | undefined;
    send(message: ClientMessage): void;
    open(): void;
    close(): void;
};
export {};
