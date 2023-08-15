import { type ClientRoutes, type SocketData } from './utils.js';
export type Options = {
    protocols?: string[];
    signal?: AbortSignal;
    backoff?: BackoffOptions;
    WebSocket?: WebSocketLike;
};
export type WebSocketClientOptions = Options & {
    url: string;
    onConnection?: (connection: Connection) => void | PromiseLike<void>;
    onMessage: (message: SocketData, isBinary: boolean) => void;
};
export type Connection = {
    protocol: string;
    extensions: string;
    closed: Promise<CloseEvent>;
    send(message: SocketData): void;
    close(code?: number, reason?: string): void;
};
type WebSocketLike = new (url: string, protocols?: string | string[]) => WebSocket;
type BackoffOptions = {
    jitter: boolean;
    maxDelay: number;
    numOfAttempts: number;
    retry: (e: unknown, attemptNumber: number) => boolean | Promise<boolean>;
    startingDelay: number;
    timeMultiple: number;
};
export declare function createClient<Router extends ClientRoutes>(): {
    router: Router;
    subscribe: <T>(observer: (value: T) => void, signal?: AbortSignal) => void;
    listen: (url: string, handler: (connection: Connection) => void | PromiseLike<void>, options?: Options) => Promise<void>;
};
export declare function createWebSocketClient(options: WebSocketClientOptions): {
    send: (message: SocketData) => void;
    listen: () => Promise<void>;
};
export {};
