import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import * as lib from './core.js';
export { RPCClientError, connectionClosedException, createChannel, getContextKey, createContext, } from './core.js';
const adapter = async (options) => {
    options.signal.throwIfAborted();
    const ws = new WebSocket(options.url);
    ws.binaryType = 'nodebuffer';
    await new Promise((resolve, reject) => {
        const onOpen = () => {
            ws.off('error', onError);
            options.signal.removeEventListener('abort', onAbort);
            resolve();
        };
        const onError = (error) => {
            ws.off('open', onOpen);
            options.signal.removeEventListener('abort', onAbort);
            reject(error);
        };
        const onAbort = () => {
            ws.off('open', onOpen);
            ws.off('error', onError);
            ws.close(1000);
            reject(options.signal.reason);
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
        options.signal.addEventListener('abort', onAbort);
    });
    ws.on('message', (data, isBinary) => {
        options.message(isBinary ? data : data.toString());
    });
    ws.on('close', (code, reason) => {
        options.close(code, reason.toString());
    });
    return {
        message: (data) => {
            ws.send(data);
        },
        close: (code, reason) => {
            ws.close(code, reason);
        },
    };
};
export const connect = (options) => lib.connect('WebSocket' in globalThis ? options : { ...options, adapter });
export function createClient() {
    const client = lib.createClient();
    if ('WebSocket' in globalThis)
        return client;
    return {
        router: client.router,
        connect: (options) => client.connect({ ...options, adapter }),
    };
}
class UpgradeContext {
    request;
    #head;
    #wss;
    #url;
    #cookies;
    constructor(request, head, wss) {
        this.request = request;
        this.#head = head;
        this.#wss = wss;
    }
    get url() {
        this.#url ??= new URL(this.request.url, `http://${this.request.headers.host}`);
        return this.#url;
    }
    get cookies() {
        if (this.#cookies)
            return this.#cookies;
        const h = this.request.headers.cookie;
        this.#cookies = {};
        if (!h)
            return this.#cookies;
        let index = 0;
        while (index < h.length) {
            const eqIdx = h.indexOf('=', index);
            // no more cookie pairs
            if (eqIdx === -1)
                break;
            let endIdx = h.indexOf(';', index);
            if (endIdx === -1) {
                endIdx = h.length;
            }
            else if (endIdx < eqIdx) {
                // backtrack on prior semicolon
                index = h.lastIndexOf(';', eqIdx - 1) + 1;
                continue;
            }
            const key = h.slice(index, eqIdx).trim();
            // only assign once
            if (undefined === this.#cookies[key]) {
                let val = h.slice(eqIdx + 1, endIdx).trim();
                // quoted values
                if (val.codePointAt(0) === 0x22) {
                    val = val.slice(1, -1);
                }
                this.#cookies[key] = decodeURIComponent(val);
            }
            index = endIdx + 1;
        }
        return this.#cookies;
    }
    upgrade() {
        let result;
        this.#wss.handleUpgrade(this.request, this.request.socket, this.#head, (ws) => {
            result = ws;
            this.#wss.emit('connection', ws, this.request);
        });
        return result;
    }
    reject(code) {
        if (code < 400 || !(code in http.STATUS_CODES))
            code = 500;
        const status = http.STATUS_CODES[code];
        const head = [
            `HTTP/1.1 ${code} ${status}`,
            'Connection: close',
            'Content-Type: text/plain',
            `Content-Length: ${Buffer.byteLength(status)}`,
        ];
        this.request.socket.once('finish', () => this.request.socket.destroy());
        this.request.socket.end(`${head.join('\r\n')}\r\n\r\n${status}`);
    }
}
export function createServer() {
    const server = lib.createServer();
    async function serve(options = {}) {
        options.signal?.throwIfAborted();
        const onError = options.error ?? console.error.bind(console);
        const wss = new WebSocketServer({ noServer: true });
        const hts = http.createServer(options.request ??
            ((req, res) => {
                const body = http.STATUS_CODES[426];
                res.writeHead(426, {
                    'Content-Length': body.length,
                    'Content-Type': 'text/plain',
                });
                res.end(body);
            }));
        hts.on('upgrade', (request, socket, head) => {
            if (!options.upgrade) {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                });
                return;
            }
            const ctx = new UpgradeContext(request, head, wss);
            void (async () => {
                await options.upgrade(ctx);
            })().catch((error) => {
                onError(error);
                ctx.reject(500);
            });
        });
        wss.on('connection', (ws) => {
            const client = server.connect({
                key: ws,
                transforms: options.transforms,
                pingTimeout: options.pingTimeout,
                pongTimeout: options.pongTimeout,
                message: (data) => {
                    ws.send(data);
                },
                close: () => {
                    ws.terminate();
                },
                error: options.error,
            });
            ws.on('message', (data, isBinary) => {
                client.message(isBinary ? data : data.toString());
            });
            ws.on('close', () => {
                client.close(lib.connectionClosedException);
            });
        });
        options.signal?.addEventListener('abort', () => {
            hts.close();
            wss.close();
        });
        hts.listen(options.port ?? process.env.PORT ?? 3000);
        await once(hts, 'listening');
        hts.on('error', onError);
        wss.on('error', onError);
    }
    return { ...server, serve };
}
