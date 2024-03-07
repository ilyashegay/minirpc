import * as devalue from 'devalue';
export const connectionClosedException = new DOMException('Connection closed', 'WebSocketConnectionClosedError');
function isClientMessage(message) {
    return (typeof message.id === 'number' &&
        typeof message.method === 'string' &&
        Array.isArray(message.params));
}
function isServerMessage(message) {
    return (typeof message.id === 'number' &&
        ('result' in message || 'error' in message));
}
function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
const ArrayBufferViews = {
    DataView,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
};
function createTransport(send, transforms) {
    const inboundStreams = new Map();
    const outboundStreams = new Map();
    let expectedChunk;
    let lastMessageTime = 0;
    let nextStreamId = 1;
    let closed = false;
    const reducers = {};
    const revivers = {};
    if (transforms) {
        for (const key of Object.keys(transforms)) {
            reducers[key] = transforms[key][0];
            revivers[key] = transforms[key][1];
        }
    }
    reducers.ReadableStream = (value) => {
        if (!(value instanceof ReadableStream))
            return;
        const id = nextStreamId++;
        void sendStream(id, value);
        return id;
    };
    revivers.ReadableStream = (id) => {
        return new ReadableStream({
            start(controller) {
                inboundStreams.set(id, {
                    controller,
                    canceled: false,
                });
            },
            cancel(reason) {
                const stream = inboundStreams.get(id);
                invariant(stream);
                stream.canceled = true;
                send(JSON.stringify({ id, stream: 'cancel', reason: String(reason) }));
            },
        });
    };
    async function sendStream(id, stream) {
        const controller = new AbortController();
        outboundStreams.set(id, controller);
        controller.signal.addEventListener('abort', () => {
            void reader.cancel(controller.signal.reason);
        });
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (typeof value === 'string' ||
                    value instanceof ArrayBuffer ||
                    ArrayBuffer.isView(value)) {
                    let type = typeof value === 'string'
                        ? 'string'
                        : value instanceof ArrayBuffer
                            ? 'ArrayBuffer'
                            : value.constructor.name;
                    if (type === 'Buffer')
                        type = 'Uint8Array';
                    send(`{"stream":"chunk","id":${id},"type":"${type}"}`);
                    send(value);
                }
                else {
                    const data = devalue.stringify(value);
                    send(`{"stream":"chunk","id":${id},"data":${data}}`);
                }
            }
            send(`{"stream":"done","id":${id}}`);
        }
        catch (error) {
            if (controller.signal.aborted)
                return;
            send(JSON.stringify({ stream: 'error', id, error: String(error) }));
        }
        finally {
            reader.releaseLock();
            outboundStreams.delete(id);
        }
    }
    function convertBufferType(data, type) {
        if (typeof data === 'string') {
            invariant(type === 'string');
            return data;
        }
        if (type === 'ArrayBuffer') {
            return data instanceof ArrayBuffer
                ? data
                : data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                    ? data.buffer
                    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        const View = ArrayBufferViews[type];
        invariant(View);
        return data instanceof ArrayBuffer
            ? new View(data, 0, data.byteLength)
            : new View(data.buffer, data.byteOffset, data.byteLength);
    }
    function receiveMessage(data) {
        invariant(!closed);
        lastMessageTime = Date.now();
        if (expectedChunk) {
            const stream = inboundStreams.get(expectedChunk.id);
            invariant(stream);
            const type = expectedChunk.type;
            expectedChunk = undefined;
            if (stream.canceled)
                return;
            stream.controller.enqueue(convertBufferType(data, type));
            return;
        }
        invariant(typeof data === 'string');
        if (data === 'ping') {
            send('pong');
            return;
        }
        if (data === 'pong') {
            return;
        }
        const message = JSON.parse(data);
        if (Array.isArray(message)) {
            return devalue.unflatten(message, revivers);
        }
        invariant('stream' in message);
        if (message.stream === 'cancel') {
            const stream = outboundStreams.get(message.id);
            invariant(stream);
            stream.abort(message.reason);
            return;
        }
        if (message.stream === 'chunk') {
            if ('type' in message) {
                expectedChunk = message;
                return;
            }
            const stream = inboundStreams.get(message.id);
            invariant(stream);
            if (stream.canceled)
                return;
            stream.controller.enqueue(devalue.unflatten(message.data));
        }
        if (message.stream === 'done') {
            const stream = inboundStreams.get(message.id);
            invariant(stream);
            inboundStreams.delete(message.id);
            if (stream.canceled)
                return;
            stream.controller.close();
        }
        if (message.stream === 'error') {
            const stream = inboundStreams.get(message.id);
            invariant(stream);
            inboundStreams.delete(message.id);
            if (stream.canceled)
                return;
            stream.controller.error(message.error);
        }
    }
    return {
        parse: receiveMessage,
        send: (message) => {
            invariant(!closed);
            send(devalue.stringify(message, reducers));
        },
        close(reason) {
            invariant(!closed);
            closed = true;
            for (const stream of inboundStreams.values()) {
                stream.controller.error(reason);
                stream.canceled = true;
            }
            for (const stream of outboundStreams.values()) {
                stream.abort(reason);
            }
        },
        getTimeSinceLastMessage() {
            return Date.now() - lastMessageTime;
        },
        ping(latency, onResult) {
            invariant(!closed);
            send('ping');
            const pingTime = Date.now();
            setTimeout(() => {
                if (!closed)
                    onResult(lastMessageTime >= pingTime);
            }, latency);
        },
    };
}
const nativeAdapter = async (options) => {
    options.signal.throwIfAborted();
    const ws = new WebSocket(options.url);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
        const onOpen = () => {
            ws.removeEventListener('error', onError);
            options.signal.removeEventListener('abort', onAbort);
            resolve();
        };
        const onError = () => {
            ws.removeEventListener('open', onOpen);
            options.signal.removeEventListener('abort', onAbort);
            reject(new Error('Connection failed'));
        };
        const onAbort = () => {
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.close(1000);
            reject(options.signal.reason);
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        options.signal.addEventListener('abort', onAbort);
    });
    ws.addEventListener('message', (event) => {
        options.message(event.data);
    });
    ws.addEventListener('close', (event) => {
        options.close(event.code, event.reason);
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
        if (options.error) {
            options.error(error);
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
                await options.connection?.(connection);
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
    const queries = new Map();
    let nextRequestId = 1;
    let transport;
    let messageQueue;
    let onError;
    async function connect(options) {
        onError = options.error ?? console.error.bind(console);
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
                let closedHandle;
                const closed = new Promise((resolve, reject) => {
                    closedHandle = { resolve, reject };
                });
                const onAbort = () => {
                    connection.close(1000);
                };
                controller.signal.addEventListener('abort', onAbort);
                const connection = await (options.adapter ?? nativeAdapter)({
                    url: options.url,
                    signal: controller.signal,
                    message: receiveSocketData,
                    close(code, reason) {
                        controller.signal.removeEventListener('abort', onAbort);
                        clearInterval(interval);
                        transport?.close(connectionClosedException);
                        transport = undefined;
                        for (const handle of queries.values()) {
                            handle.reject(connectionClosedException);
                        }
                        closedHandle.resolve({ code, reason });
                    },
                });
                const interval = setInterval(() => {
                    transport?.ping(options.pongTimeout ?? 1e3, (alive) => {
                        if (!alive)
                            connection.close(1001);
                    });
                }, options.pingInterval ?? 10e3);
                transport = createTransport(connection.message, options.transforms);
                messageQueue?.forEach(transport.send);
                messageQueue = undefined;
                return { closed, close: connection.close };
            }
            catch (error) {
                if (controller.signal.aborted)
                    throw controller.signal.reason;
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
            async function safeObserver(value) {
                try {
                    await observer(value);
                }
                catch (error) {
                    if (options.error) {
                        options.error(error);
                    }
                    else {
                        onError(error);
                    }
                }
            }
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
                        void safeObserver(value);
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
                if (options.error) {
                    options.error(error);
                }
                else {
                    onError(error);
                }
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
export class RPCClientError extends Error {
}
function makeWare(stack) {
    return {
        use(fn) {
            return makeWare([...stack, fn]);
        },
        routes(routes) {
            const methods = {};
            for (const key of Object.keys(routes)) {
                methods[key] = (...args) => {
                    for (const fn of stack) {
                        fn();
                    }
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                    return routes[key](...args);
                };
            }
            return methods;
        },
    };
}
export function createChannel(onSubscribe, onUnsubscribe) {
    const subs = new Set();
    return {
        get size() {
            return subs.size;
        },
        push: (payload) => {
            for (const controller of subs) {
                controller.enqueue(payload);
            }
        },
        pull: (...args) => {
            let c;
            return new ReadableStream({
                async start(controller) {
                    c = controller;
                    if (onSubscribe) {
                        controller.enqueue(await onSubscribe(...args));
                    }
                    subs.add(controller);
                },
                async cancel() {
                    subs.delete(c);
                    await onUnsubscribe?.();
                },
            });
        },
    };
}
class Ctx {
    static currentClient;
    static data = new WeakMap();
    #value;
    constructor(initialValue) {
        this.#value = initialValue;
    }
    get() {
        return this.#value;
    }
    set(value) {
        this.#value = value;
    }
    update(updateFn) {
        this.#value = updateFn(this.#value);
    }
}
export function getContextKey() {
    invariant(Ctx.currentClient, 'Context accessed out of bounds');
    return Ctx.currentClient;
}
export function createContext(initialValue) {
    const reader = (key) => {
        key ??= getContextKey();
        let contextData = Ctx.data.get(key);
        if (!contextData) {
            contextData = new WeakMap();
            Ctx.data.set(key, contextData);
        }
        let context = contextData.get(reader);
        if (!context) {
            context = new Ctx(initialValue);
            contextData.set(reader, context);
        }
        return context;
    };
    return reader;
}
export function createServer() {
    const methods = {};
    const use = (fn) => makeWare([fn]);
    function router(routes) {
        for (const key of Object.keys(routes)) {
            if (key in methods)
                throw new Error(`Duplicate method ${key}`);
            const fn = routes[key];
            methods[key] = async (id, params, respond, onError) => {
                try {
                    respond({ id, result: await fn(...params) });
                }
                catch (error) {
                    if (error instanceof RPCClientError) {
                        respond({ id, error: error.message });
                    }
                    else {
                        respond({ id, error: true });
                        onError(error);
                    }
                }
            };
        }
        return {};
    }
    function connect(client) {
        const onError = client.error ?? console.error.bind(console);
        const transport = createTransport(client.message, client.transforms);
        let activityTimeout;
        const pingTimeout = client.pingTimeout ?? 60e3;
        function setActivityTimer() {
            if (activityTimeout)
                return;
            activityTimeout = setTimeout(checkActivity, pingTimeout - transport.getTimeSinceLastMessage());
        }
        function onPong(alive) {
            if (alive) {
                setActivityTimer();
            }
            else {
                client.close();
            }
        }
        function checkActivity() {
            if (transport.getTimeSinceLastMessage() < pingTimeout) {
                setActivityTimer();
            }
            else {
                transport.ping(client.pongTimeout ?? 1e3, onPong);
            }
        }
        return {
            message(data) {
                try {
                    setActivityTimer();
                    const request = transport.parse(data);
                    if (request === undefined)
                        return;
                    invariant(isClientMessage(request), 'Unknown message format');
                    if (!(request.method in methods)) {
                        transport.send({
                            id: request.id,
                            error: `Unknown method: ${request.method}`,
                        });
                        return;
                    }
                    Ctx.currentClient = client.key;
                    void methods[request.method](request.id, request.params, transport.send, onError);
                    Ctx.currentClient = undefined;
                }
                catch (error) {
                    onError(error);
                }
            },
            close(reason) {
                clearTimeout(activityTimeout);
                transport.close(reason);
            },
        };
    }
    return { connect, router, use };
}
