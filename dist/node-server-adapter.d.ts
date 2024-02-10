/// <reference types="node" />
import http from 'node:http';
import { type WebSocket } from 'ws';
import type { MiniRPCServer } from './server.js';
type UpgradeContext = {
    request: http.IncomingMessage;
    upgrade(): WebSocket;
    error(code: number): void;
};
export default function serve(options: {
    rpc: MiniRPCServer;
    port?: number;
    signal?: AbortSignal;
    onRequest?: http.RequestListener;
    onUpgrade?: (ctx: UpgradeContext) => unknown;
    onError: (error: unknown) => void;
}): Promise<void>;
export {};
