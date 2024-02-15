import { type ClientRoutes, type SocketData, type DevalueTransforms } from './utils.js';
export type { DevalueTransforms };
export type Connection = {
    protocol: string;
    extensions: string;
    closed: Promise<{
        code?: number;
        reason?: string;
    }>;
    send(message: SocketData): void;
    close(code?: number, reason?: string): void;
};
type Client<Router extends ClientRoutes> = {
    router: Router;
    connect(options: ConnectOptions): Promise<Connection>;
};
type ConnectOptions = {
    url: string;
    protocols?: string | string[];
    signal?: AbortSignal;
    backoff?: Partial<BackoffOptions>;
    transforms?: DevalueTransforms;
    heartbeat?: {
        interval?: number;
        latency?: number;
    };
    adapter?: Adapter;
    onError?: (error: unknown) => void;
};
export type Adapter = (options: {
    url: string;
    protocols?: string | string[];
    signal: AbortSignal;
    onMessage: (data: SocketData) => void;
}) => Promise<Connection>;
type BackoffOptions = {
    jitter: boolean;
    maxDelay: number;
    numOfAttempts: number;
    retry: (e: unknown, attemptNumber: number) => boolean | Promise<boolean>;
    startingDelay: number;
    timeMultiple: number;
};
export declare function connect<Router extends ClientRoutes>(options: ConnectOptions & {
    client?: Client<Router>;
    onConnection?: (connection: Connection) => void | PromiseLike<void>;
}): Router;
export declare function createClient<Router extends ClientRoutes>(): Client<Router>;
