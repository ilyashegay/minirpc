import { type Connection } from '@minirpc/connect';
import { type ClientRoutes, type SocketData, type DevalueTransforms } from './utils.js';
export type { Connection, DevalueTransforms };
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
export declare function createClient<Router extends ClientRoutes>({ transforms, onError, }?: {
    transforms?: DevalueTransforms;
    onError?: (error: unknown) => void;
}): {
    router: Router;
    listen: (url: string, handler: (connection: Connection) => void | PromiseLike<void>, options?: Options) => Promise<void>;
};
export declare function createWebSocketClient(options: WebSocketClientOptions): {
    send: (message: SocketData, enqueue?: boolean) => void;
    listen: () => Promise<void>;
};
