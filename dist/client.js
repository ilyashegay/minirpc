import { makeMessenger, invariant, } from './utils.js';
export default function createClient(options) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = new Map();
    let nextRequestId = 1;
    let messenger;
    let queue;
    const onError = options.onError ?? console.error.bind(console);
    const connectionClosedException = new DOMException('Connection closed', 'WebSocketConnectionClosedError');
    const client = createWebSocketClient({
        ...options,
        async onConnection(connection) {
            const controller = new AbortController();
            try {
                messenger = makeMessenger(client.send, controller.signal, options.transforms);
                queue?.forEach(messenger.send);
                queue = undefined;
                await options.onConnection?.(connection);
            }
            finally {
                controller.abort(connectionClosedException);
                messenger = undefined;
                for (const handle of queries.values()) {
                    handle.reject(connectionClosedException);
                }
            }
        },
        onMessage(data) {
            invariant(messenger);
            const message = messenger.parse(data);
            if (message === undefined)
                return;
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
        },
    });
    const interval = setInterval(() => {
        client.send('heartbeat');
    }, 15e3);
    options.signal?.addEventListener('abort', () => {
        clearInterval(interval);
    });
    void client.listen().catch(onError);
    function query(method, params) {
        const promise = new Promise((resolve, reject) => {
            const id = nextRequestId++;
            const message = { id, method, params };
            if (messenger) {
                messenger.send(message);
            }
            else {
                queue ??= [];
                queue.push(message);
            }
            queries.set(id, { resolve, reject });
        });
        promise.subscribe = (observer, options = {}) => {
            const handleError = options.onError ?? onError;
            promise
                .then(async (stream) => {
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
                    return;
                }
                handleError(error);
            });
        };
        return promise;
    }
    return new Proxy({}, {
        get(_, prop) {
            return (...args) => {
                if (typeof prop === 'string') {
                    return query(prop, args);
                }
            };
        },
    });
}
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
            reject(new DOMException(String(signal.reason), 'AbortError'));
        };
        signal.addEventListener('abort', onAbort);
    });
}
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
        const onError = (error) => {
            ws.removeEventListener('open', onOpen);
            signal.removeEventListener('abort', onAbort);
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(error);
        };
        const onAbort = () => {
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.close(1000, String(signal.reason));
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
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
                const reason = String(signal.reason);
                ws.removeEventListener('close', onClose);
                ws.close(1000, reason);
                resolve({ code: 1000, reason });
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
function createWebSocketClient(options) {
    const abortController = new AbortController();
    if (options.signal) {
        const signal = options.signal;
        signal.throwIfAborted();
        signal.addEventListener('abort', () => {
            abortController.abort(signal.reason);
        });
    }
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
    function send(message, enqueue = false) {
        if (connection) {
            connection.send(message);
        }
        else if (enqueue) {
            queue ??= [];
            queue.push(message);
        }
        else {
            throw new Error('no websocket connection');
        }
    }
    async function listen() {
        try {
            for (;;) {
                for (let attempt = 0;;) {
                    try {
                        connection = await (options.adapter ?? nativeAdapter)({
                            url: options.url,
                            protocols: options.protocols,
                            onMessage: options.onMessage,
                            signal: abortController.signal,
                        });
                        break;
                    }
                    catch (error) {
                        await backoff(error, ++attempt, backOffOptions, abortController.signal);
                    }
                }
                void connection.closed.then(() => {
                    connection = undefined;
                });
                if (queue?.length) {
                    for (const message of queue) {
                        connection.send(message);
                    }
                    queue = undefined;
                }
                await options.onConnection?.(connection);
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                await connection?.closed;
                connection = undefined;
            }
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return;
            }
            throw error;
        }
        finally {
            connection?.close();
        }
    }
    return { send, listen };
}
