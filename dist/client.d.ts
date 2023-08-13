import { type SafeRouter, Observable } from './utils.js';
export * from './utils.js';
export type WebSocketClientOptions = {
    protocols?: string[];
    signal?: AbortSignal;
    backoff?: BackoffOptions;
    WebSocket?: WebSocketLike;
};
export type WebSocketClientConnection = {
    protocol: string;
    extensions: string;
    closed: Promise<CloseEvent>;
    send(message: string | Uint8Array): void;
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
export declare function createClient<T, Router extends SafeRouter>(): {
    router: Router;
    events: Observable<T>;
    listen: (url: string, handler: (connection: WebSocketClientConnection) => void | PromiseLike<void>, options?: WebSocketClientOptions) => Promise<void>;
};
export declare function createWebSocketClient(options: WebSocketClientOptions & {
    url: string;
    onConnection?: (connection: WebSocketClientConnection) => void | PromiseLike<void>;
    onMessage: (message: string | Uint8Array, isBinary: boolean) => void;
}): {
    send: (message: string | Uint8Array) => void;
    listen: () => Promise<void>;
};
