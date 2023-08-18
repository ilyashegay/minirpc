import { type Connection } from 'connect';
import { type ClientRoutes, type SocketData } from './utils.js';
export { type Connection };
export type Options = {
    protocols?: string[];
    signal?: AbortSignal;
    backoff?: Partial<BackoffOptions>;
};
export type WebSocketClientOptions = Options & {
    url: string;
    onConnection?: (connection: Connection) => void | PromiseLike<void>;
    onMessage: (message: SocketData) => void;
};
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
    send: (message: SocketData, enqueue?: boolean) => void;
    listen: () => Promise<void>;
};
