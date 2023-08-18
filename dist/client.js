import { connect } from '@minirpc/connect';
import { makeClientMessenger, invariant, } from './utils.js';
export function createClient({ transforms, }) {
    let nextRequestId = 1;
    let messenger;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const observers = new Set();
    function subscribe(observer, signal) {
        observers.add(observer);
        signal?.addEventListener('abort', () => {
            observers.delete(observer);
        });
    }
    function query(method, params) {
        return new Promise((resolve, reject) => {
            const id = nextRequestId++;
            messenger.send({ id, method, params });
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
        invariant(!messenger, 'Already listening');
        const client = createWebSocketClient({
            url,
            async onConnection(connection) {
                try {
                    messenger.open();
                    await handler(connection);
                }
                finally {
                    messenger.close();
                    for (const handle of queries.values()) {
                        handle.reject(new DOMException('Connection closed'));
                    }
                }
            },
            onMessage(data) {
                const message = messenger.parse(data);
                if (message === undefined)
                    return;
                if ('event' in message) {
                    for (const observer of observers) {
                        observer(message.event);
                    }
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
                    handle.reject(typeof message.error === 'string'
                        ? message.error
                        : 'request failed');
                }
            },
            ...options,
        });
        messenger = makeClientMessenger(client.send, transforms);
        return client.listen();
    }
    return { router, subscribe, listen };
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
        options.signal.throwIfAborted();
        options.signal.addEventListener('abort', () => {
            abortController.abort();
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
                if (queue?.length) {
                    for (const message of queue) {
                        connection.send(message);
                    }
                    queue = undefined;
                }
                await options.onConnection?.(connection);
                await connection.closed;
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
