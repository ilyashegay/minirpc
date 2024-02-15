import { createTransport, isServerMessage, invariant, connectionClosedException, } from './utils.js';
const nativeAdapter = async ({ url, protocols, signal, onMessage, }) => {
    signal.throwIfAborted();
    const ws = new WebSocket(url, protocols);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
        const onOpen = () => {
            ws.removeEventListener('error', onError);
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        const onError = () => {
            ws.removeEventListener('open', onOpen);
            signal.removeEventListener('abort', onAbort);
            reject(new Error('Connection failed'));
        };
        const onAbort = () => {
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.close(1000);
            reject(signal.reason);
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        signal.addEventListener('abort', onAbort);
    });
    ws.addEventListener('message', (event) => {
        onMessage(event.data);
    });
    return {
        protocol: ws.protocol,
        extensions: ws.extensions,
        closed: new Promise((resolve) => {
            const onClose = (event) => {
                signal.removeEventListener('abort', onAbort);
                resolve({ code: event.code, reason: event.reason });
            };
            const onAbort = () => {
                ws.removeEventListener('close', onClose);
                ws.addEventListener('close', (event) => {
                    resolve({ code: event.code, reason: event.reason });
                });
                ws.close(1000);
            };
            ws.addEventListener('close', onClose);
            signal.addEventListener('abort', onAbort);
        }),
        send(data) {
            ws.send(data);
        },
        close(code, reason) {
            ws.close(code, reason);
        },
    };
};
async function backoff(error, attempt, options, signal) {
    signal.throwIfAborted();
    const shouldRetry = await options.retry(error, attempt);
    if (!shouldRetry || attempt >= options.numOfAttempts) {
        throw error;
    }
    let delay = Math.min(options.startingDelay * Math.pow(options.timeMultiple, attempt - 1), options.maxDelay);
    if (options.jitter) {
        delay = Math.round(Math.random() * delay);
    }
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delay);
        const onAbort = () => {
            clearTimeout(timeout);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort);
    });
}
export function connect(options) {
    function handleError(error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return true;
        }
        if (options.onError) {
            options.onError(error);
        }
        else {
            console.error(error);
        }
        return false;
    }
    const client = options.client ?? createClient();
    void (async () => {
        for (;;) {
            let connection;
            try {
                connection = await client.connect(options);
            }
            catch (error) {
                handleError(error);
                break;
            }
            try {
                await options.onConnection?.(connection);
            }
            catch (error) {
                if (handleError(error))
                    break;
            }
            await connection.closed;
        }
    })();
    return client.router;
}
export function createClient() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = new Map();
    let nextRequestId = 1;
    let transport;
    let messageQueue;
    let onError;
    async function connect(options) {
        onError = options.onError ?? console.error.bind(console);
        const backOffOptions = {
            jitter: false,
            maxDelay: Infinity,
            numOfAttempts: 10,
            retry: () => true,
            startingDelay: 100,
            timeMultiple: 2,
            ...(options.backoff ?? {}),
        };
        const controller = new AbortController();
        if (options.signal) {
            const signal = options.signal;
            signal.throwIfAborted();
            signal.addEventListener('abort', () => {
                if (signal.reason instanceof Error) {
                    controller.abort(signal.reason);
                }
                else {
                    controller.abort();
                }
            });
        }
        for (let attempt = 0;;) {
            try {
                const connection = await (options.adapter ?? nativeAdapter)({
                    url: options.url,
                    protocols: options.protocols,
                    signal: controller.signal,
                    onMessage: receiveSocketData,
                });
                const interval = setInterval(() => {
                    transport?.ping(options.heartbeat?.latency ?? 1e3, (alive) => {
                        if (!alive)
                            connection.close(1001);
                    });
                }, options.heartbeat?.interval ?? 10e3);
                void connection.closed.then(() => {
                    clearInterval(interval);
                    transport?.close(connectionClosedException);
                    transport = undefined;
                    for (const handle of queries.values()) {
                        handle.reject(connectionClosedException);
                    }
                });
                transport = createTransport((data) => {
                    connection.send(data);
                }, options.transforms);
                messageQueue?.forEach(transport.send);
                messageQueue = undefined;
                return connection;
            }
            catch (error) {
                await backoff(error, ++attempt, backOffOptions, controller.signal);
            }
        }
    }
    function receiveSocketData(data) {
        try {
            invariant(transport);
            const message = transport.parse(data);
            if (message === undefined)
                return;
            invariant(isServerMessage(message));
            const handle = queries.get(message.id);
            invariant(handle, `Unknown response ID: ${message.id}`);
            queries.delete(message.id);
            if ('result' in message) {
                handle.resolve(message.result);
            }
            else {
                handle.reject(typeof message.error === 'string' ? message.error : 'request failed');
            }
        }
        catch (error) {
            onError(error);
        }
    }
    function query(method, params) {
        const promise = new Promise((resolve, reject) => {
            const id = nextRequestId++;
            const message = { id, method, params };
            if (transport) {
                transport.send(message);
            }
            else {
                messageQueue ??= [];
                messageQueue.push(message);
            }
            queries.set(id, { resolve, reject });
        });
        promise.subscribe = (observer, options = {}) => {
            promise
                .then(async (stream) => {
                const handleError = options.onError ?? onError;
                invariant(stream instanceof ReadableStream, 'Expected ReadableStream');
                const reader = stream.getReader();
                const onAbort = () => {
                    void reader.cancel(options.signal?.reason);
                };
                options.signal?.addEventListener('abort', onAbort);
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        try {
                            Promise.resolve(observer(value)).catch(handleError);
                        }
                        catch (error) {
                            handleError(error);
                        }
                    }
                }
                finally {
                    reader.releaseLock();
                    options.signal?.removeEventListener('abort', onAbort);
                }
            })
                .catch((error) => {
                if (error === connectionClosedException) {
                    query(method, params).subscribe(observer, options);
                    return;
                }
                ;
                (options.onError ?? onError)(error);
            });
        };
        return promise;
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
    return { router, connect };
}
