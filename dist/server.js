import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { makeServerMessenger, stringifySimple, invariant, } from './utils.js';
export class RPCClientError extends Error {
}
export function createServer(onError) {
    const methods = {};
    let wss;
    function router(routes) {
        for (const key of Object.keys(routes)) {
            if (key in methods)
                throw new Error(`Duplicate method ${key}`);
            methods[key] = routes[key];
        }
        return {};
    }
    function broadcast(event) {
        if (!wss.clients.size)
            return;
        const message = stringifySimple({ event });
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
    function listen(options = {}) {
        invariant(!wss, 'Already Listening');
        const heartbeats = new WeakMap();
        wss = new WebSocketServer({ noServer: true });
        wss.on('connection', (ws) => {
            const abortController = new AbortController();
            const messenger = makeServerMessenger((data) => {
                ws.send(data);
            }, abortController.signal);
            heartbeats.set(ws, Date.now());
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            ws.on('message', async (data, isBinary) => {
                invariant(Buffer.isBuffer(data));
                const request = messenger.parse(isBinary ? data : data.toString());
                if (request === 'heartbeat') {
                    heartbeats.set(ws, Date.now());
                    return;
                }
                if (request === undefined)
                    return;
                try {
                    const { id, method, params } = request;
                    if (method in methods) {
                        const result = await methods[method](...params);
                        messenger.send({ id, result: result ?? null });
                    }
                    else {
                        messenger.send({ id, error: `Unknown method: ${method}` });
                    }
                }
                catch (error) {
                    if (error instanceof RPCClientError) {
                        messenger.send({ id: request.id, error: error.message });
                    }
                    else {
                        messenger.send({ id: request.id, error: true });
                        onError(error);
                    }
                }
            });
            const unsubscribe = options.onConnection?.({
                send: (event) => {
                    messenger.send({ event });
                },
                close: ws.close.bind(ws),
                terminate: ws.terminate.bind(ws),
            });
            if (unsubscribe) {
                ws.once('close', (code, reason) => {
                    abortController.abort();
                    unsubscribe({ code, reason: reason.toString() });
                });
            }
        });
        const interval = setInterval(() => {
            const limit = Date.now() - (options.heartbeat ?? 60e3);
            for (const ws of wss.clients) {
                if (heartbeats.get(ws) < limit) {
                    ws.terminate();
                    continue;
                }
            }
        }, 10e3);
        const server = http.createServer(options.onRequest ??
            ((req, res) => {
                const body = http.STATUS_CODES[426];
                res.writeHead(426, {
                    'Content-Length': body.length,
                    'Content-Type': 'text/plain',
                });
                res.end(body);
            }));
        server.on('upgrade', (request, socket, head) => {
            socket.on('error', onError);
            try {
                if (options.authenticate && !options.authenticate(request)) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
            }
            catch (error) {
                onError(error);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
        });
        server.on('error', onError);
        options.signal?.addEventListener('abort', () => {
            clearInterval(interval);
            server.close();
            wss.close();
        });
        return new Promise((resolve) => {
            server.listen(options.port ?? process.env.PORT ?? 3000, resolve);
        });
    }
    return { router, broadcast, listen };
}
