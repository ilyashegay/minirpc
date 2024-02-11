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
declare function backoff(error: unknown, attempt: number, options: BackoffOptions, signal: AbortSignal): Promise<void>;
declare const _default: <Router extends ClientRoutes<import("./utils.js").ServerRoutes>>(options: {
    url: string;
    protocols?: string | string[] | undefined;
    signal?: AbortSignal | undefined;
    backoff?: Partial<BackoffOptions> | undefined;
    transforms?: DevalueTransforms | undefined;
    heartbeat?: {
        interval?: number | undefined;
        latency?: number | undefined;
    } | undefined;
    adapter?: Adapter | undefined;
    onConnection?: ((connection: Connection) => void | PromiseLike<void>) | undefined;
    onError?: ((error: unknown) => void) | undefined;
}) => Router;
export default _default;
