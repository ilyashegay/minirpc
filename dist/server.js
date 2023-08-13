import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { RPCClientError, makeMessageParser, stringifySimple, makeMessageSender, } from './utils.js';
export * from './utils.js';
function safety(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        }
        catch (error) {
            return Promise.reject(error);
        }
    };
}
export function createServer(onError) {
    const methods = {};
    let wss;
    function handleMessage(methods, request, callback) {
        if (!(request.method in methods)) {
            callback({ id: request.id, error: `Unknown method: ${request.method}` });
            return;
        }
        methods[request.method](...request.params)
            .then((result) => {
            callback({ id: request.id, result: result ?? null });
        })
            .catch((error) => {
            let message = true;
            if (error instanceof RPCClientError) {
                message = error.message;
                error = undefined;
            }
            callback({ id: request.id, error: message }, error);
        });
    }
    function router(router) {
        const result = {};
        for (const key of Object.keys(router)) {
            if (key in methods)
                throw new Error(`Duplicate method ${key}`);
            methods[key] = result[key] = safety(router[key]);
        }
        return result;
    }
    function broadcast(event) {
        if (!wss?.clients.size)
            return;
        const message = stringifySimple({ event });
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
    function listen(options) {
        const alive = new WeakSet();
        const wss = new WebSocketServer({ noServer: true });
        wss.on('connection', (ws) => {
            const parser = makeMessageParser();
            const sender = makeMessageSender((data) => {
                ws.send(data);
            });
            ws.on('message', (data, isBinary) => {
                if (!Buffer.isBuffer(data)) {
                    throw new Error('Wrong Buffer Type');
                }
                const request = parser(data, isBinary);
                if (request === undefined)
                    return;
                handleMessage(methods, request, (response, error) => {
                    if (error)
                        onError(error);
                    sender(response);
                });
            });
            ws.on('pong', () => {
                alive.add(ws);
            });
            const unsubscribe = options.onConnection({
                send(event) {
                    sender({ event });
                },
                close(code, data) {
                    ws.close(code, data);
                },
                terminate() {
                    ws.terminate();
                },
            });
            if (unsubscribe) {
                ws.once('close', unsubscribe);
            }
        });
        const interval = setInterval(() => {
            for (const ws of wss.clients) {
                if (!alive.has(ws)) {
                    ws.terminate();
                    continue;
                }
                alive.delete(ws);
                ws.ping();
            }
        }, 30000);
        const server = http.createServer(options.onRequest ??
            ((req, res) => {
                const body = http.STATUS_CODES[426];
                res.writeHead(426, {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
