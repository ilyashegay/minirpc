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
export default function createClient<Router extends ClientRoutes>(options: {
    url: string;
    protocols?: string | string[];
    signal?: AbortSignal;
    backoff?: Partial<BackoffOptions>;
    transforms?: DevalueTransforms;
    adapter?: Adapter;
    onConnection?: (connection: Connection) => void | PromiseLike<void>;
    onError?: (error: unknown) => void;
}): Router;
