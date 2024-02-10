import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { invariant } from './utils.js';
export default async function serve(options) {
    options.signal?.throwIfAborted();
    const wss = new WebSocketServer({ noServer: true });
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
        if (!options.onUpgrade) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
            return;
        }
        const ctx = {
            request,
            upgrade() {
                let result;
                wss.handleUpgrade(request, socket, head, (ws) => {
                    result = ws;
                    wss.emit('connection', ws, request);
                });
                invariant(result);
                return result;
            },
            error(code) {
                if (code < 400 || !(code in http.STATUS_CODES))
                    code = 500;
                const status = http.STATUS_CODES[code];
                const head = [
                    `HTTP/1.1 ${code} ${status}`,
                    'Connection: close',
                    'Content-Type: text/plain',
                    `Content-Length: ${Buffer.byteLength(status)}`,
                ];
                socket.once('finish', () => socket.destroy());
                socket.end(`${head.join('\r\n')}\r\n\r\n${status}`);
            },
        };
        try {
            Promise.resolve(options.onUpgrade(ctx)).catch((error) => {
                options.onError(error);
                ctx.error(500);
            });
        }
        catch (error) {
            options.onError(error);
            ctx.error(500);
        }
    });
    const connector = options.rpc.run({ signal: options.signal });
    wss.on('connection', (ws) => {
        const client = connector({
            key: ws,
            send: (data) => {
                ws.send(data);
            },
            terminate: ws.terminate.bind(ws),
        });
        ws.on('message', (data, isBinary) => {
            invariant(Buffer.isBuffer(data));
            client.message(isBinary ? data : data.toString());
        });
        ws.on('close', (code, reason) => {
            client.close(code, reason);
        });
    });
    options.signal?.addEventListener('abort', () => {
        server.close();
        wss.close();
    });
    server.listen(options.port ?? process.env.PORT ?? 3000);
    await once(server, 'listening');
    server.on('error', options.onError);
    wss.on('error', options.onError);
}
