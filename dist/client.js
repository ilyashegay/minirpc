import { Observable, sleep, makeMessageParser, makeMessageSender, } from './utils.js';
export * from './utils.js';
export function createClient() {
    let nextRequestId = 1;
    const queries = new Map();
    const events = new Observable();
    const requests = new Observable();
    function handleMessage(message) {
        if ('event' in message) {
            events.next(message.event);
            return;
        }
        const handle = queries.get(message.id);
        if (!handle) {
            console.error(`Unknown response ID: ${message.id}`);
            return;
        }
        queries.delete(message.id);
        if ('result' in message) {
            handle.resolve(message.result);
        }
        else {
            handle.reject(typeof message.error === 'string' ? message.error : 'request failed');
        }
    }
    function query(method, params) {
        return new Promise((resolve, reject) => {
            const id = nextRequestId++;
            requests.next({ id, method, params });
            queries.set(id, { resolve, reject });
        });
    }
    const router = new Proxy({}, {
        get(_, prop) {
            return (...args) => {
                if (typeof prop === 'string') {
                    return query(prop, args);
                }
            };
        },
    });
    async function listen(url, handler, options = {}) {
        const parser = makeMessageParser();
        const client = createWebSocketClient({
            url,
            onConnection: handler,
            onMessage(data, isBinary) {
                const message = parser(data, isBinary);
                if (message === undefined)
                    return;
                handleMessage(message);
            },
            ...options,
        });
        requests.subscribe(makeMessageSender(client.send));
        setInterval(() => {
            client.send('heartbeat');
        }, 20000);
        return client.listen();
    }
    return { router, events, listen };
}
function getBackoffDelay(attempt, options) {
    const delay = Math.min(options.startingDelay * Math.pow(options.timeMultiple, attempt), options.maxDelay);
    return options.jitter ? Math.round(Math.random() * delay) : delay;
}
async function connect(url, options) {
    for (let attempt = 0;;) {
        const ws = new options.WebSocket(url, options.protocols);
        try {
            await Promise.race([
                options.aborted,
                new Promise((resolve, reject) => {
                    ws.addEventListener('open', () => {
                        resolve();
                        ws.removeEventListener('error', reject);
                    });
                    ws.addEventListener('error', reject);
                }),
            ]);
            return ws;
        }
        catch (error) {
            attempt++;
            const shouldRetry = await options.backoff.retry(error, attempt);
            if (!shouldRetry || attempt >= options.backoff.numOfAttempts) {
                throw error;
            }
            await Promise.race([
                sleep(getBackoffDelay(attempt, options.backoff)),
                options.aborted,
            ]);
        }
    }
}
function abortSignalToRejectedPromise(signal) {
    if (!signal)
        return new Promise(() => undefined);
    if (signal.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
    }
    return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
        });
    });
}
export function createWebSocketClient(options) {
    const aborted = abortSignalToRejectedPromise(options.signal);
    const backOffOptions = {
        jitter: false,
        maxDelay: Infinity,
        numOfAttempts: 10,
        retry: () => true,
        startingDelay: 100,
        timeMultiple: 2,
        ...(options.backoff ?? {}),
    };
    let queue;
    let connection;
    function send(message) {
        if (connection) {
            connection.send(message);
        }
        else {
            queue ??= [];
            queue.push(message);
        }
    }
    function onMessageEvent(message) {
        options.onMessage(message.data, typeof message.data !== 'string');
    }
    async function listen() {
        try {
            for (;;) {
                const ws = await connect(options.url, {
                    WebSocket: options.WebSocket ?? WebSocket,
                    aborted,
                    protocols: options.protocols,
                    backoff: backOffOptions,
                });
                ws.addEventListener('message', onMessageEvent);
                if (queue?.length) {
                    for (const message of queue) {
                        ws.send(message);
                    }
                    queue = undefined;
                }
                connection = {
                    protocol: ws.protocol,
                    extensions: ws.extensions,
                    closed: Promise.race([
                        aborted,
                        new Promise((resolve) => {
                            ws.addEventListener('close', resolve);
                        }),
                    ]),
                    send(data) {
                        ws.send(data);
                    },
                    close(code, reason) {
                        ws.close(code, reason);
                    },
                };
                await options.onConnection?.(connection);
                await connection.closed;
                connection = undefined;
            }
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return;
            }
        }
        finally {
            connection?.close();
        }
    }
    return { send, listen };
}
