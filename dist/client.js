import { connect } from '@minirpc/connect';
import { makeMessenger, invariant, } from './utils.js';
export function createClient({ transforms, } = {}) {
    let started = false;
    let nextRequestId = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = new Map();
    let messenger;
    let queue;
    const connectionClosedException = new DOMException('Connection closed', 'WebSocketConnectionClosedError');
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
        promise.subscribe = async (observer, signal) => {
            const stream = await promise;
            invariant(stream instanceof ReadableStream);
            const reader = stream.getReader();
            const onAbort = () => {
                void reader.cancel(signal?.reason);
            };
            signal?.addEventListener('abort', onAbort);
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    observer(value);
                }
            }
            catch (error) {
                if (error === connectionClosedException) {
                    return;
                }
                throw error;
            }
            finally {
                reader.releaseLock();
                signal?.removeEventListener('abort', onAbort);
            }
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
    async function listen(url, handler, options = {}) {
        invariant(!started, 'Already listening');
        started = true;
        const client = createWebSocketClient({
            url,
            async onConnection(connection) {
                const controller = new AbortController();
                try {
                    messenger = makeMessenger(client.send, controller.signal, transforms);
                    queue?.forEach(messenger.send);
                    queue = undefined;
                    await handler(connection);
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
                    handle.reject(typeof message.error === 'string'
                        ? message.error
                        : 'request failed');
                }
            },
            ...options,
        });
        const interval = setInterval(() => {
            client.send('heartbeat');
        }, 15e3);
        options.signal?.addEventListener('abort', () => {
            clearInterval(interval);
        });
        return client.listen();
    }
    return { router, listen };
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
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort);
    });
}
export function createWebSocketClient(options) {
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
                        connection = await connect(options.url, options.protocols, options.onMessage, abortController.signal);
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
