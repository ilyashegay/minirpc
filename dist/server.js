import { createTransport, isClientMessage, invariant, } from './utils.js';
export {};
export class RPCClientError extends Error {
}
export function createServer(options = {}) {
    const methods = {};
    const onError = options.onError ?? console.error.bind(console);
    const use = (fn) => makeWare([fn]);
    function router(routes) {
        for (const key of Object.keys(routes)) {
            if (key in methods)
                throw new Error(`Duplicate method ${key}`);
            methods[key] = routes[key];
        }
        return {};
    }
    function connect(client) {
        const transport = createTransport(client.send, options.transforms);
        let activityTimeout;
        const heartbeatInterval = options.heartbeat?.interval ?? 60e3;
        function setActivityTimer() {
            activityTimeout ??= setTimeout(checkActivity, heartbeatInterval - transport.getTimeSinceLastMessage());
        }
        function checkActivity() {
            if (transport.getTimeSinceLastMessage() < heartbeatInterval) {
                setActivityTimer();
                return;
            }
            transport.ping(options.heartbeat?.latency ?? 1e3, (alive) => {
                if (alive) {
                    setActivityTimer();
                }
                else {
                    client.close();
                }
            });
        }
        return {
            message(data) {
                let request;
                try {
                    request = transport.parse(data);
                    if (request === undefined)
                        return;
                    invariant(isClientMessage(request), 'Unknown message format');
                }
                catch (error) {
                    onError(error);
                    return;
                }
                try {
                    setActivityTimer();
                    const { id, method, params } = request;
                    if (!(method in methods)) {
                        transport.send({ id, error: `Unknown method: ${method}` });
                        return;
                    }
                    Ctx.currentClient = client.key;
                    Promise.resolve(methods[method](...params))
                        .then((result) => {
                        transport.send({ id, result });
                    })
                        .catch((error) => {
                        if (error instanceof RPCClientError) {
                            transport.send({ id, error: error.message });
                        }
                        else {
                            transport.send({ id, error: true });
                            onError(error);
                        }
                    });
                    Ctx.currentClient = undefined;
                }
                catch (error) {
                    if (error instanceof RPCClientError) {
                        transport.send({ id: request.id, error: error.message });
                    }
                    else {
                        transport.send({ id: request.id, error: true });
                        onError(error);
                    }
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
