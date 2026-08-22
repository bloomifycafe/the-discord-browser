/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import electron, { clipboard, type IpcMainInvokeEvent, Menu, MenuItem, session, shell, webContents } from "electron";
import { unzipSync } from "fflate";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, normalize as normalizePath } from "path";

const PARTITION = "persist:vc-in-app-browser";

const MAX_FAVICON_BYTES = 128 * 1024;
const EXTENSIONS_DIR = join(DATA_DIR, "browserExtensions");
const INSTALLER_PARTITION = "vc-in-app-browser-installer";
const SHIM_PATH = join(DATA_DIR, "browserExtensionShim.js");
const SW_WRAPPER = "vc-iab-service-worker.js";
const BG_PAGE = "vc-iab-background.html";
const BG_SHIM = "vc-iab-background-shim.js";
const SW_SHIM = "vc-iab-sw-shim.js";
const USER_SCRIPT_WORLD = 1001;
const USER_SCRIPT_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval' *; object-src 'self'";
const USER_SCRIPTS_FILE = join(DATA_DIR, "browserExtensionUserScripts.json");

const SW_SHIM_SOURCE = `
self.__vcIabRelay = true;

self.skipWaiting();
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

(() => {
    const PULL_TIMEOUT = 20000;

    const queue = [];
    const collectors = [];
    const answers = new Map();
    let seq = 0;

    const flush = () => {
        while (queue.length > 0 && collectors.length > 0) {
            const collector = collectors.shift();
            clearTimeout(collector.timer);
            collector.respond({ batch: queue.splice(0, queue.length) });
        }
    };

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        const relay = message === null || typeof message !== "object" ? null : message.__vcIabRelay;

        if (relay === "ping") {
            respond({ alive: true });
            return true;
        }

        if (relay === "pull") {
            const collector = { respond };
            collector.timer = setTimeout(() => {
                const index = collectors.indexOf(collector);
                if (index !== -1) collectors.splice(index, 1);
                respond({ batch: [] });
            }, PULL_TIMEOUT);

            collectors.push(collector);
            flush();
            return true;
        }

        if (relay === "answer") {
            const pending = answers.get(message.id);
            if (pending) {
                answers.delete(message.id);
                pending(message.value);
            }

            respond({ ok: true });
            return true;
        }

        const id = ++seq;
        answers.set(id, respond);
        queue.push({
            id,
            message,
            sender: {
                url: sender ? sender.url : undefined,
                origin: sender ? sender.origin : undefined,
                frameId: sender ? sender.frameId : 0,
                tabId: sender && sender.tab ? sender.tab.id : undefined
            }
        });

        flush();
        return true;
    });
})();
`;

const USER_SCRIPTS_SOURCE = `
(() => {
    const pending = new Map();
    let seq = 0;

    window.addEventListener("message", event => {
        const data = event.data;
        if (event.source !== window || data?.__vcIab !== "reply" || !pending.has(data.id)) return;

        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? reject(new Error(data.error)) : resolve(data.result);
    });

    const call = (method, payload) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        window.postMessage({ __vcIab: "user-scripts", id, method, payload }, "*");
    });

    const install = () => {
        if (typeof chrome === "undefined" || chrome === null) return false;

        chrome.userScripts = {
            register: scripts => call("register", scripts),
            update: scripts => call("update", scripts),
            unregister: filter => call("unregister", filter ?? null),
            getScripts: filter => call("getScripts", filter ?? null),
            execute: injection => call("execute", injection),
            configureWorld: () => Promise.resolve(),
            resetWorldConfiguration: () => Promise.resolve(),
            getWorldConfigurations: () => Promise.resolve([]),
            onUserScriptMessage: { addListener() { }, removeListener() { }, hasListener: () => false }
        };

        return true;
    };

    if (install()) return;

    const timer = setInterval(() => { if (install()) clearInterval(timer); }, 20);
    setTimeout(() => clearInterval(timer), 10000);
})();
`;

const DISPATCH_SOURCE = `
(() => {
    const install = () => {
        if (typeof chrome === "undefined" || !chrome.runtime?.id || location.protocol !== "chrome-extension:") return false;

        const listeners = new Set();
        const original = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
        const originalRemove = chrome.runtime.onMessage.removeListener.bind(chrome.runtime.onMessage);

        chrome.runtime.onMessage.addListener = listener => {
            listeners.add(listener);
            return original(listener);
        };
        chrome.runtime.onMessage.removeListener = listener => {
            listeners.delete(listener);
            return originalRemove(listener);
        };

        const connectListeners = new Set();
        const originalConnect = chrome.runtime.onConnect.addListener.bind(chrome.runtime.onConnect);
        const originalConnectRemove = chrome.runtime.onConnect.removeListener.bind(chrome.runtime.onConnect);

        chrome.runtime.onConnect.addListener = listener => {
            connectListeners.add(listener);
            return originalConnect(listener);
        };
        chrome.runtime.onConnect.removeListener = listener => {
            connectListeners.delete(listener);
            return originalConnectRemove(listener);
        };

        const openPorts = new Map();

        const resolveSender = raw => {
            const info = raw ?? {};
            const tab = (window.__vcIabTabs?.list ?? []).find(item => item.id === info.tabId);

            return {
                ...info,
                id: chrome.runtime.id,
                frameId: info.frameId ?? 0,
                tab: info.tabId === undefined ? undefined : tab ?? {
                    id: info.tabId, index: 0, windowId: 0, active: false, highlighted: false,
                    incognito: false, pinned: false, status: "complete", url: info.url, title: ""
                }
            };
        };

        chrome.runtime.onUserScriptMessage = chrome.runtime.onMessage;
        chrome.runtime.onUserScriptConnect = chrome.runtime.onConnect;

        window.__vcIabConnect = (portId, name, sender) => {
            const listeners = new Set();
            const disconnects = new Set();

            const port = {
                name, sender: resolveSender(sender),
                postMessage: message => window.postMessage({ __vcIab: "bg-port-out", portId, message }, "*"),
                onMessage: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l), hasListener: l => listeners.has(l) },
                onDisconnect: { addListener: l => disconnects.add(l), removeListener: l => disconnects.delete(l), hasListener: l => disconnects.has(l) },
                disconnect: () => window.postMessage({ __vcIab: "bg-port-close", portId }, "*")
            };

            openPorts.set(portId, { port, listeners, disconnects });

            for (const listener of connectListeners) {
                try {
                    listener(port);
                } catch (error) {
                    console.error("[vc-iab] onConnect listener failed", error);
                }
            }
        };

        window.__vcIabPortIn = (portId, message) => {
            const entry = openPorts.get(portId);
            if (!entry) return;

            for (const listener of entry.listeners) {
                try {
                    listener(message, entry.port);
                } catch (error) {
                    console.error("[vc-iab] port message listener failed", error);
                }
            }
        };

        window.__vcIabPortGone = portId => {
            const entry = openPorts.get(portId);
            if (!entry) return;

            openPorts.delete(portId);
            for (const listener of entry.disconnects) {
                try {
                    listener(entry.port);
                } catch (error) {
                    console.error("[vc-iab] port disconnect listener failed", error);
                }
            }
        };

        window.__vcIabDispatch = (message, sender) => new Promise(resolve => {
            const resolved = resolveSender(sender);
            let settled = false;
            let keepOpen = false;
            const respond = value => { if (!settled) { settled = true; resolve(value ?? null); } };

            for (const listener of listeners) {
                try {
                    if (listener(message, resolved, respond) === true) keepOpen = true;
                } catch (error) {
                    console.error("[vc-iab] message listener failed", error);
                }
            }

            if (!keepOpen) respond(null);
            else setTimeout(() => respond(null), 5000);
        });

        return true;
    };

    if (install()) return;

    const timer = setInterval(() => { if (install()) clearInterval(timer); }, 20);
    setTimeout(() => clearInterval(timer), 10000);
})();
`;

const grantedStoreIds = new Set<string>();

function loadUserScriptGrants() {
    grantedStoreIds.clear();
    for (const [storeId, allowed] of Object.entries(readUserScriptGrants())) {
        if (allowed === true) grantedStoreIds.add(storeId);
    }
}

function readUserScriptGrants(): Record<string, boolean> {
    try {
        return JSON.parse(readFileSync(USER_SCRIPTS_FILE, "utf8"));
    } catch {
        return {};
    }
}

export function setUserScriptsAllowed(_: IpcMainInvokeEvent, storeId: string, allowed: boolean) {
    if (typeof storeId !== "string" || !/^[a-z0-9_-]+$/i.test(storeId)) return { ok: false, error: "Unknown extension." };

    const grants = readUserScriptGrants();
    if (allowed) grants[storeId] = true;
    else delete grants[storeId];

    try {
        writeFileSync(USER_SCRIPTS_FILE, JSON.stringify(grants, null, 2));
    } catch (error) {
        return { ok: false, error: String(error).slice(0, 160) };
    }

    loadUserScriptGrants();
    writeExtensionShim();

    const extension = loadedExtensions.find(item => item.storeId === storeId);
    const background = extension && webContents.getAllWebContents()
        .find(contents => contents.getURL().startsWith(`chrome-extension://${extension.id}/${BG_PAGE}`));

    background?.reload();

    return { ok: true };
}

const BG_SHIM_SOURCE = `
(() => {
    const resolved = () => Promise.resolve();

    self.skipWaiting ??= resolved;
    self.registration ??= {
        scope: location.origin + "/",
        active: null, waiting: null, installing: null,
        update: resolved,
        unregister: () => Promise.resolve(true),
        showNotification: resolved,
        getNotifications: () => Promise.resolve([])
    };
    self.clients ??= {
        claim: resolved,
        matchAll: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        openWindow: () => Promise.resolve(null)
    };
    self.importScripts ??= (...urls) => {
        for (const url of urls) {
            const script = document.createElement("script");
            script.src = url;
            script.async = false;
            document.head.appendChild(script);
        }
    };

    const lifecycle = new Set(["install", "activate"]);
    const ignored = new Set(["fetch", "push", "sync", "periodicsync", "notificationclick", "notificationclose"]);
    const addEventListener = self.addEventListener.bind(self);

    self.addEventListener = (type, listener, options) => {
        if (ignored.has(type)) return;
        if (!lifecycle.has(type)) return addEventListener(type, listener, options);

        queueMicrotask(() => {
            try {
                listener({ type, waitUntil: value => value });
            } catch (error) {
                console.error("[vc-iab] background " + type + " handler failed", error);
            }
        });
    };
})();
`;

const moduleWorkers = new Set<string>();

function prepareBackground(folder: string) {
    const manifestPath = join(folder, "manifest.json");

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const background = manifest?.background;
        if (!background) return null;

        const worker = background.service_worker === SW_WRAPPER
            ? recoverWorker(folder)
            : background.service_worker;

        if (typeof worker !== "string" || worker.length === 0) return null;

        writeFileSync(join(folder, SW_SHIM), SW_SHIM_SOURCE + `self.__vcIabWorker = ${JSON.stringify(worker)};\n`);
        if (background.type === "module") moduleWorkers.add(folder);

        writeFileSync(join(folder, SW_WRAPPER), background.type === "module"
            ? `import "./${SW_SHIM}";\n`
            : `importScripts("${SW_SHIM}");\n`);

        if (background.service_worker !== SW_WRAPPER) {
            background.service_worker = SW_WRAPPER;
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }

        const type = background.type === "module" ? ' type="module"' : "";
        writeFileSync(join(folder, BG_SHIM), BG_SHIM_SOURCE);
        writeFileSync(join(folder, BG_PAGE), [
            "<!doctype html>",
            '<meta charset="utf-8">',
            "<title>background</title>",
            `<script src="${BG_SHIM}"></script>`,
            `<script${type} src="${worker}"></script>`,
            ""
        ].join("\n"));

        return BG_PAGE;
    } catch {
        return null;
    }
}

function recoverWorker(folder: string) {
    const read = (name: string) => {
        try {
            return readFileSync(join(folder, name), "utf8");
        } catch {
            return "";
        }
    };

    const marked = /__vcIabWorker = "(.+?)"/.exec(read(SW_SHIM))?.[1];
    if (marked) return marked;

    return [...read(SW_WRAPPER).matchAll(/(?:import "\.\/|importScripts\(")(.+?)"/g)]
        .map(match => match[1])
        .find(name => name !== SW_SHIM) ?? null;
}

const SHIM_SOURCE = `
(() => {
    const install = () => {
        if (typeof chrome === "undefined" || chrome === null) return false;

        const noop = () => {};
        const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

        if (location.protocol === "chrome-extension:" && chrome.tabs != null) {
            const waiting = new Map();
            let injectSeq = 0;

            window.addEventListener("message", event => {
                const data = event.data;
                if (event.source !== window || data?.__vcIab !== "inject-reply" || !waiting.has(data.id)) return;

                const settle = waiting.get(data.id);
                waiting.delete(data.id);
                settle(data.result);
            });

            const inject = (channel, tabId, details, callback) => {
                const answer = new Promise(resolve => {
                    const id = ++injectSeq;
                    waiting.set(id, resolve);
                    window.postMessage({ __vcIab: "inject", channel, id, tabId, details }, "*");
                });

                if (typeof callback !== "function") return answer;

                answer.then(value => callback(value), () => callback(undefined));
                return undefined;
            };

            chrome.tabs.executeScript = (tabId, details, callback) =>
                inject("vc-iab-execute-script", tabId, details, callback);
            chrome.tabs.insertCSS = (tabId, details, callback) =>
                inject("vc-iab-insert-css", tabId, details, callback);
        }

        if (location.protocol === "chrome-extension:" && chrome.webRequest != null) {
            const groups = {};

            const typeMatches = (filter, details) => {
                if (!filter || !Array.isArray(filter.types)) return true;
                return filter.types.indexOf(details.type) !== -1;
            };

            const urlMatches = (filter, details) => {
                if (!filter || !Array.isArray(filter.urls) || filter.urls.length === 0) return true;

                for (const pattern of filter.urls) {
                    if (pattern === "<all_urls>") return true;

                    const split = pattern.indexOf("://");
                    if (split === -1) continue;

                    const scheme = pattern.slice(0, split);
                    if (scheme !== "*" && details.url.indexOf(scheme + ":") !== 0) continue;
                    if (scheme === "*" && details.url.indexOf("http") !== 0) continue;

                    return true;
                }

                return false;
            };

            const makeEvent = name => ({
                addListener(listener, filter, extra) {
                    if (!groups[name]) groups[name] = [];
                    groups[name].push({
                        listener,
                        filter: filter || null,
                        blocking: Array.isArray(extra) && extra.indexOf("blocking") !== -1
                    });
                    window.postMessage({ __vcIab: "webrequest-register", event: name }, "*");
                },
                removeListener(listener) {
                    const list = groups[name];
                    if (!list) return;

                    const index = list.findIndex(entry => entry.listener === listener);
                    if (index !== -1) list.splice(index, 1);
                },
                hasListener(listener) {
                    return (groups[name] || []).some(entry => entry.listener === listener);
                }
            });

            for (const name of ["onBeforeRequest", "onHeadersReceived"]) chrome.webRequest[name] = makeEvent(name);

            window.addEventListener("message", event => {
                const data = event.data;
                if (event.source !== window || data?.__vcIab !== "webrequest-run") return;

                let result = null;

                for (const entry of groups[data.event] || []) {
                    if (!typeMatches(entry.filter, data.details) || !urlMatches(entry.filter, data.details)) continue;

                    try {
                        const answer = entry.listener(data.details);
                        if (entry.blocking && answer && (answer.cancel || answer.redirectUrl)) {
                            result = { cancel: answer.cancel === true, redirectUrl: answer.redirectUrl };
                            break;
                        }
                    } catch (error) {
                        console.error("[vc-iab] webRequest listener failed", error);
                    }
                }

                window.postMessage({ __vcIab: "webrequest-result", id: data.id, result }, "*");
            });
        }

        if (location.protocol === "chrome-extension:" && (window.__vcIabHosted || []).includes(chrome.runtime.id)) {
            const fromBackground = location.pathname.endsWith("/${BG_PAGE}");
            const nativeSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
            const pending = new Map();
            let seq = 0;

            window.addEventListener("message", messageEvent => {
                const data = messageEvent.data;
                if (messageEvent.source !== window || data?.__vcIab !== "ext-reply" || !pending.has(data.id)) return;

                const settle = pending.get(data.id);
                pending.delete(data.id);
                settle(data.error ? undefined : data.result, data.error);
            });

            const dispatch = message => new Promise(resolve => {
                const id = ++seq;
                pending.set(id, resolve);
                window.postMessage({ __vcIab: "ext-message", id, message, fromBackground }, "*");
            });

            if (!fromBackground) {
                const ports = new Map();
                let portSeq = 0;

                window.addEventListener("message", portEvent => {
                    const data = portEvent.data;
                    if (portEvent.source !== window) return;

                    const entry = data?.portId === undefined ? null : ports.get(data.portId);
                    if (!entry) return;

                    if (data.__vcIab === "ext-port-in") {
                        for (const listener of entry.listeners) {
                            try {
                                listener(data.message, entry.port);
                            } catch (error) {
                                console.error("[vc-iab] port listener failed", error);
                            }
                        }
                    }

                    if (data.__vcIab === "ext-port-closed") {
                        ports.delete(data.portId);
                        for (const listener of entry.disconnects) {
                            try {
                                listener(entry.port);
                            } catch (error) {
                                console.error("[vc-iab] port disconnect listener failed", error);
                            }
                        }
                    }
                });

                chrome.runtime.connect = info => {
                    const portId = "e" + (++portSeq);
                    const name = typeof info === "string" ? info : info?.name ?? "";
                    const listeners = new Set();
                    const disconnects = new Set();

                    const port = {
                        name,
                        sender: { id: chrome.runtime.id, url: location.href },
                        postMessage: message => window.postMessage({ __vcIab: "ext-port", portId, message }, "*"),
                        onMessage: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l), hasListener: l => listeners.has(l) },
                        onDisconnect: { addListener: l => disconnects.add(l), removeListener: l => disconnects.delete(l), hasListener: l => disconnects.has(l) },
                        disconnect: () => {
                            ports.delete(portId);
                            window.postMessage({ __vcIab: "ext-port-close", portId }, "*");
                        }
                    };

                    ports.set(portId, { port, listeners, disconnects });
                    window.postMessage({ __vcIab: "ext-connect", portId, name }, "*");

                    return port;
                };
            }

            const localFirst = async message => {
                if (!fromBackground || !window.__vcIabDispatch) return dispatch(message);

                const mine = await window.__vcIabDispatch(message, {
                    url: location.href, origin: location.origin, frameId: 0
                });

                return mine === null || mine === undefined ? dispatch(message) : mine;
            };

            chrome.runtime.sendMessage = (...args) => {
                const message = args.length > 1 && typeof args[0] === "string" ? args[1] : args[0];
                const callback = args.find(arg => typeof arg === "function");
                const answer = localFirst(message);

                if (typeof callback !== "function") return answer;

                answer.then(value => callback(value), () => callback(undefined));
                return undefined;
            };

            if (fromBackground) {
                let collecting = false;

                const repairWorker = async () => {
                    const wanted = chrome.runtime.getURL("/" + SW_WRAPPER);
                    const settled = async () => (await navigator.serviceWorker.getRegistrations())
                        .some(entry => entry.active?.scriptURL === wanted);

                    for (let attempt = 0; attempt < 5; attempt++) {
                        if (await settled()) return;

                        const registrations = await navigator.serviceWorker.getRegistrations();
                        await Promise.all(registrations.map(entry => entry.unregister()));
                        await navigator.serviceWorker.register("/" + SW_WRAPPER, {
                            type: moduleWorkerIds.includes(chrome.runtime.id) ? "module" : "classic",
                            scope: "/"
                        });

                        await new Promise(done => setTimeout(done, 1000));
                    }
                };

                const collect = () => {
                    if (collecting) return;
                    collecting = true;

                    let answered = false;
                    const again = wait => {
                        if (answered) return;
                        answered = true;
                        collecting = false;
                        setTimeout(collect, wait);
                    };

                    nativeSendMessage({ __vcIabRelay: "pull" }, reply => {
                        const batch = reply && Array.isArray(reply.batch) ? reply.batch : [];

                        for (const item of batch) {
                            Promise.resolve(window.__vcIabDispatch ? window.__vcIabDispatch(item.message, item.sender) : null)
                                .then(value => nativeSendMessage({ __vcIabRelay: "answer", id: item.id, value }, () => { }));
                        }

                        again(batch.length > 0 ? 0 : 50);
                    });

                    setTimeout(() => again(1000), 30000);
                };

                repairWorker().catch(() => { }).then(collect);
            }
        }
        const settle = value => (...args) => {
            const callback = args[args.length - 1];
            if (typeof callback === "function") callback(value);
            return Promise.resolve(value);
        };

        if (chrome.tabs != null && typeof chrome.tabs.create !== "function") {
            chrome.tabs.create = (properties, callback) => {
                const url = typeof properties === "string" ? properties : properties?.url;
                window.postMessage({ __vcIab: "tabs-create", url }, "*");

                const tab = { id: -1, index: 0, windowId: 0, url, pendingUrl: url, active: properties?.active !== false,
                    pinned: false, highlighted: false, incognito: false, selected: false, discarded: false,
                    autoDiscardable: true, frozen: false, groupId: -1, status: "loading" };

                if (typeof callback === "function") callback(tab);
                return Promise.resolve(tab);
            };
        }

        const updatedListeners = new Set();
        const activatedListeners = new Set();
        const removedListeners = new Set();

        const fire = (listeners, args) => {
            for (const listener of listeners) {
                try {
                    listener(...args);
                } catch (error) {
                    console.error("[vc-iab] tab listener failed", error);
                }
            }
        };

        window.__vcIabTabs = {
            list: window.__vcIabTabsSeed || [],
            setTabs(tabs) {
                window.__vcIabTabs.list = tabs;
            },
            emit(payload) {
                fire(updatedListeners, [payload.id, payload.changeInfo, payload.tab]);
            },
            activated(tabId) {
                fire(activatedListeners, [{ tabId, windowId: 0 }]);
            },
            removed(tabId) {
                fire(removedListeners, [tabId, { windowId: 0, isWindowClosing: false }]);
            },
            navigate(kind, details) {
                fire(navigationListeners[kind] ?? new Set(), [details]);
            }
        };

        const navigationListeners = {
            onBeforeNavigate: new Set(),
            onCommitted: new Set(),
            onDOMContentLoaded: new Set(),
            onCompleted: new Set(),
            onHistoryStateUpdated: new Set(),
            onReferenceFragmentUpdated: new Set(),
            onCreatedNavigationTarget: new Set(),
            onErrorOccurred: new Set()
        };

        window.addEventListener("message", event => {
            const data = event.data;
            if (event.source !== window || data?.__vcIab !== "ext-event") return;

            const tabs = window.__vcIabTabs;
            if (data.kind === "tabs") tabs.setTabs(data.payload);
            if (data.kind === "update") tabs.emit(data.payload);
            if (data.kind === "activated") tabs.activated(data.payload);
            if (data.kind === "removed") tabs.removed(data.payload);
            if (data.kind === "navigate") tabs.navigate(data.payload.kind, data.payload.details);
        });

        const listenerGroup = listeners => ({
            addListener: listener => listeners.add(listener),
            removeListener: listener => listeners.delete(listener),
            hasListener: listener => listeners.has(listener)
        });

        if (chrome.tabs != null) {
            const currentWindow = populate => ({
                id: 0, focused: true, incognito: false, alwaysOnTop: false,
                type: "normal", state: "normal", top: 0, left: 0, width: 1280, height: 800,
                tabs: populate ? window.__vcIabTabs.list : undefined
            });

            const windowCall = (args, build) => {
                const callback = args.find(arg => typeof arg === "function");
                const info = args.find(arg => arg !== null && typeof arg === "object");
                const result = build(info?.populate === true);

                if (typeof callback === "function") callback(result);
                return Promise.resolve(result);
            };

            chrome.windows = {
                ...chrome.windows,
                WINDOW_ID_NONE: -1,
                WINDOW_ID_CURRENT: -2,
                get: (...args) => windowCall(args, currentWindow),
                getCurrent: (...args) => windowCall(args, currentWindow),
                getLastFocused: (...args) => windowCall(args, currentWindow),
                getAll: (...args) => windowCall(args, populate => [currentWindow(populate)]),
                onCreated: chrome.windows?.onCreated ?? event(),
                onRemoved: chrome.windows?.onRemoved ?? event(),
                onFocusChanged: chrome.windows?.onFocusChanged ?? event()
            };

            chrome.tabs.onUpdated = listenerGroup(updatedListeners);
            chrome.tabs.onActivated = listenerGroup(activatedListeners);
            chrome.tabs.onRemoved = listenerGroup(removedListeners);

            chrome.tabs.query = (filter, callback) => {
                const matches = tab => {
                    if (filter == null) return true;
                    if (filter.active !== undefined && tab.active !== filter.active) return false;
                    if (filter.audible !== undefined && tab.audible !== filter.audible) return false;
                    if (filter.status !== undefined && tab.status !== filter.status) return false;
                    if (filter.pinned !== undefined && tab.pinned !== filter.pinned) return false;
                    if (filter.windowId !== undefined && tab.windowId !== filter.windowId) return false;
                    return true;
                };

                const tabs = window.__vcIabTabs.list.filter(matches);
                if (typeof callback === "function") callback(tabs);
                return Promise.resolve(tabs);
            };

            chrome.tabs.get = (tabId, callback) => {
                const tab = window.__vcIabTabs.list.find(item => item.id === tabId);

                if (typeof callback === "function") {
                    callback(tab);
                    return;
                }

                return tab ? Promise.resolve(tab) : Promise.reject(new Error("No tab with id " + tabId));
            };

            chrome.tabs.update = (tabId, properties, callback) => {
                if (typeof tabId === "object" && tabId !== null) {
                    callback = properties;
                    properties = tabId;
                    tabId = null;
                }

                window.postMessage({ __vcIab: "tabs-update", tabId, url: properties?.url }, "*");

                const tab = { id: tabId ?? -1, url: properties?.url, active: true, windowId: 0, index: 0 };
                if (typeof callback === "function") callback(tab);
                return Promise.resolve(tab);
            };

            chrome.tabs.remove = (tabIds, callback) => {
                window.postMessage({ __vcIab: "tabs-remove", tabIds: Array.isArray(tabIds) ? tabIds : [tabIds] }, "*");
                if (typeof callback === "function") callback();
                return Promise.resolve();
            };
        }

        const action = {
            setBadgeBackgroundColor: settle(),
            setBadgeTextColor: settle(),
            setBadgeText: settle(),
            setIcon: settle(),
            setTitle: settle(),
            getTitle: settle(""),
            setPopup: settle(),
            getPopup: settle(""),
            enable: settle(),
            disable: settle(),
            onClicked: event()
        };

        if (!chrome.action) chrome.action = action;
        if (!chrome.browserAction) chrome.browserAction = action;

        if (!chrome.contextMenus) {
            chrome.contextMenus = {
                create: (_details, callback) => { if (typeof callback === "function") callback(); return "vc-iab-stub"; },
                update: settle(),
                remove: settle(),
                removeAll: settle(),
                onClicked: event()
            };
        }

        if (!chrome.commands) chrome.commands = { getAll: settle([]), onCommand: event() };

        chrome.webNavigation = {
            ...chrome.webNavigation,
            getFrame: settle(null),
            getAllFrames: settle([]),
            onBeforeNavigate: listenerGroup(navigationListeners.onBeforeNavigate),
            onCommitted: listenerGroup(navigationListeners.onCommitted),
            onDOMContentLoaded: listenerGroup(navigationListeners.onDOMContentLoaded),
            onCompleted: listenerGroup(navigationListeners.onCompleted),
            onHistoryStateUpdated: listenerGroup(navigationListeners.onHistoryStateUpdated),
            onReferenceFragmentUpdated: listenerGroup(navigationListeners.onReferenceFragmentUpdated),
            onCreatedNavigationTarget: listenerGroup(navigationListeners.onCreatedNavigationTarget),
            onErrorOccurred: listenerGroup(navigationListeners.onErrorOccurred)
        };

        chrome.permissions = {
            contains: settle(true),
            getAll: settle({ permissions: [], origins: [] }),
            request: settle(false),
            remove: settle(false),
            ...chrome.permissions,
            onAdded: chrome.permissions?.onAdded ?? event(),
            onRemoved: chrome.permissions?.onRemoved ?? event()
        };

        if (!chrome.notifications) {
            chrome.notifications = {
                create: settle("vc-iab-stub"),
                clear: settle(true),
                getAll: settle({}),
                onClicked: event(),
                onClosed: event(),
                onButtonClicked: event()
            };
        }

        if (!chrome.privacy) {
            const setting = () => ({ get: settle({ value: false, levelOfControl: "not_controllable" }), set: settle(), clear: settle() });
            chrome.privacy = {
                network: { networkPredictionEnabled: setting(), webRTCIPHandlingPolicy: setting() },
                websites: { hyperlinkAuditingEnabled: setting(), referrersEnabled: setting() }
            };
        }

        return true;
    };

    if (!install()) {
        const timer = setInterval(() => { if (install()) clearInterval(timer); }, 10);
        setTimeout(() => clearInterval(timer), 5000);
    }
})();
`;

interface UserScriptRegistration {
    id: string;
    matches: string[];
    excludeMatches: string[];
    code: string;
    runAt: string;
    allFrames: boolean;
    world: string;
}

const userScriptsByExtension = new Map<string, UserScriptRegistration[]>();

function readScriptSource(storeId: string, entry: any): string {
    if (typeof entry?.code === "string") return entry.code;
    if (typeof entry?.file !== "string") return "";

    const folder = join(EXTENSIONS_DIR, storeId);
    const target = normalizePath(join(folder, entry.file));
    if (!target.startsWith(normalizePath(folder))) return "";

    try {
        return readFileSync(target, "utf8");
    } catch {
        return "";
    }
}

function normaliseScripts(storeId: string, scripts: unknown): UserScriptRegistration[] {
    if (!Array.isArray(scripts)) return [];

    return scripts.map((script: any) => ({
        id: String(script?.id ?? ""),
        matches: Array.isArray(script?.matches) ? script.matches.map(String) : [],
        excludeMatches: Array.isArray(script?.excludeMatches) ? script.excludeMatches.map(String) : [],
        code: (Array.isArray(script?.js) ? script.js : []).map((entry: unknown) => readScriptSource(storeId, entry)).join("\n;\n"),
        runAt: typeof script?.runAt === "string" ? script.runAt : "document_idle",
        allFrames: script?.allFrames === true,
        world: script?.world === "MAIN" ? "MAIN" : "USER_SCRIPT"
    })).filter(script => script.id.length > 0 && script.code.length > 0);
}

function publicScript(script: UserScriptRegistration) {
    return {
        id: script.id,
        matches: script.matches,
        excludeMatches: script.excludeMatches,
        js: [{ code: script.code }],
        runAt: script.runAt,
        allFrames: script.allFrames,
        world: script.world
    };
}

const RESOURCE_TYPES: Record<string, string> = {
    mainFrame: "main_frame",
    subFrame: "sub_frame",
    xhr: "xmlhttprequest",
    cspReport: "csp_report",
    webSocket: "websocket"
};

const webRequestPages = new Set<number>();
const webRequestReplies = new Map<number, (result: any) => void>();
let webRequestSeq = 0;

function askExtensions(event: string, details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails) {
    const pages = [...webRequestPages]
        .map(id => webContents.fromId(id))
        .filter((contents): contents is Electron.WebContents => contents != null && !contents.isDestroyed());

    if (pages.length === 0) return Promise.resolve(null);

    const tabId = (details as any).webContentsId ?? -1;
    const guest = tabId === -1 ? null : webContents.fromId(tabId);
    const documentUrl = guest && !guest.isDestroyed() ? guest.getURL() : "";

    const shared = {
        url: details.url,
        method: (details as any).method ?? "GET",
        tabId,
        frameId: 0,
        parentFrameId: -1,
        type: RESOURCE_TYPES[details.resourceType] ?? details.resourceType,
        initiator: isWebUrl(documentUrl) ? new URL(documentUrl).origin : undefined,
        documentUrl: documentUrl || undefined,
        timeStamp: Date.now()
    };

    return Promise.all(pages.map(page => new Promise<any>(resolve => {
        const id = ++webRequestSeq;
        const timer = setTimeout(() => {
            webRequestReplies.delete(id);
            resolve(null);
        }, 1000);

        webRequestReplies.set(id, result => {
            clearTimeout(timer);
            webRequestReplies.delete(id);
            resolve(result);
        });

        page.send("vc-iab-webrequest", id, event, { ...shared, requestId: String(id) });
    }))).then(results => results.find(result => result != null) ?? null);
}

let tabSnapshot: unknown[] = [];

export function emitExtensionEvent(_: IpcMainInvokeEvent, kind: string, payload: unknown) {
    if (kind === "tabs") tabSnapshot = Array.isArray(payload) ? payload : [];

    for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed() || !contents.getURL().startsWith("chrome-extension://")) continue;
        contents.send("vc-iab-ext-event", kind, payload);
    }
}

async function evaluateInExtensionWorld(contents: Electron.WebContents, worldName: string, code: string) {
    const wasAttached = contents.debugger.isAttached();
    const contexts: Array<{ id: number; name: string; }> = [];

    const collect = (_event: unknown, method: string, params: any) => {
        if (method === "Runtime.executionContextCreated") contexts.push(params.context);
    };

    try {
        if (!wasAttached) contents.debugger.attach("1.3");
        contents.debugger.on("message", collect);

        await contents.debugger.sendCommand("Runtime.enable");
        await new Promise(done => setTimeout(done, 120));

        const world = contexts.find(context => context.name === worldName);
        if (!world) return null;

        const answer = await contents.debugger.sendCommand("Runtime.evaluate", {
            expression: code,
            contextId: world.id,
            awaitPromise: true,
            returnByValue: true
        });

        return answer?.result?.value ?? null;
    } catch {
        return null;
    } finally {
        contents.debugger.off("message", collect);
        if (!wasAttached && contents.debugger.isAttached()) {
            try {
                contents.debugger.detach();
            } catch {
            }
        }
    }
}

function registerInjectionChannels() {
    electron.ipcMain.handle("vc-iab-execute-script", async (_event, extensionId: string, tabId: number, details: any) => {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        const contents = webContents.fromId(tabId);
        if (!extension || !contents || contents.isDestroyed()) return [];

        let code = typeof details?.code === "string" ? details.code : null;

        if (code === null && typeof details?.file === "string") {
            const folder = join(EXTENSIONS_DIR, extension.storeId);
            const target = normalizePath(join(folder, details.file));
            if (!target.startsWith(normalizePath(folder))) return [];

            try {
                code = readFileSync(target, "utf8");
            } catch {
                return [];
            }
        }

        if (code === null) return [];

        return [await evaluateInExtensionWorld(contents, extension.name, code)];
    });

    electron.ipcMain.handle("vc-iab-insert-css", async (_event, extensionId: string, tabId: number, details: any) => {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        const contents = webContents.fromId(tabId);
        if (!extension || !contents || contents.isDestroyed()) return null;

        let css = typeof details?.code === "string" ? details.code : null;

        if (css === null && typeof details?.file === "string") {
            const folder = join(EXTENSIONS_DIR, extension.storeId);
            const target = normalizePath(join(folder, details.file));
            if (!target.startsWith(normalizePath(folder))) return null;

            try {
                css = readFileSync(target, "utf8");
            } catch {
                return null;
            }
        }

        if (css !== null) await contents.insertCSS(css).catch(() => null);

        return null;
    });
}

function registerNetworkBridge() {
    const browsing = session.fromPartition(PARTITION);

    electron.ipcMain.on("vc-iab-tabs-now", event => {
        event.returnValue = tabSnapshot;
    });

    electron.ipcMain.handle("vc-iab-webrequest-register", event => {
        webRequestPages.add(event.sender.id);
        event.sender.once("destroyed", () => webRequestPages.delete(event.sender.id));
    });

    electron.ipcMain.on("vc-iab-webrequest-reply", (_event, id: number, result: any) => {
        webRequestReplies.get(id)?.(result);
    });

    browsing.webRequest.onBeforeRequest((details, callback) => {
        if (!isWebUrl(details.url)) return callback({});

        askExtensions("onBeforeRequest", details).then(result => {
            if (result?.cancel) return callback({ cancel: true });
            if (result?.redirectUrl) return callback({ redirectURL: result.redirectUrl });

            callback({});
        });
    });
}

function registerUserScriptChannels() {
    electron.ipcMain.handle("vc-iab-user-scripts", (_event, extensionId: string, method: string, payload: any) => {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        if (!extension) throw new Error("Unknown extension.");
        if (!grantedStoreIds.has(extension.storeId)) throw new Error("User scripts are not allowed for this extension.");

        const current = userScriptsByExtension.get(extensionId) ?? [];

        if (method === "getScripts") {
            const ids: string[] | undefined = payload?.ids;
            return (ids ? current.filter(script => ids.includes(script.id)) : current).map(publicScript);
        }

        if (method === "register" || method === "update") {
            const incoming = normaliseScripts(extension.storeId, payload);
            const kept = current.filter(script => !incoming.some(item => item.id === script.id));
            userScriptsByExtension.set(extensionId, [...kept, ...incoming]);
        } else if (method === "unregister") {
            const ids: string[] | undefined = payload?.ids;
            userScriptsByExtension.set(extensionId, ids ? current.filter(script => !ids.includes(script.id)) : []);
        }

        writeExtensionShim();
        return null;
    });

    const openPorts = new Map<string, { guest: Electron.WebContents; extensionId: string; }>();

    function backgroundFor(extensionId: string) {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        if (!extension) return null;

        return webContents.getAllWebContents()
            .find(contents => !contents.isDestroyed() && contents.getURL().startsWith(`chrome-extension://${extension.id}/${BG_PAGE}`)) ?? null;
    }

    electron.ipcMain.handle("vc-iab-user-script-connect", (event, extensionId: string, portId: string, name: string, sender: any) => {
        const background = backgroundFor(extensionId);
        if (!background) throw new Error("No background page for this extension.");

        openPorts.set(portId, { guest: event.sender, extensionId });
        const stamped = { ...sender, tabId: event.sender.id };

        return background.executeJavaScript(
            `window.__vcIabConnect ? window.__vcIabConnect(${JSON.stringify(portId)}, ${JSON.stringify(name)}, ${JSON.stringify(stamped)}) : null`
        );
    });

    electron.ipcMain.handle("vc-iab-user-script-port", (_event, extensionId: string, portId: string, message: unknown) => {
        const background = backgroundFor(extensionId);
        if (!background) return null;

        return background.executeJavaScript(
            `window.__vcIabPortIn ? window.__vcIabPortIn(${JSON.stringify(portId)}, ${JSON.stringify(message)}) : null`
        );
    });

    electron.ipcMain.handle("vc-iab-user-script-port-close", (_event, extensionId: string, portId: string) => {
        const background = backgroundFor(extensionId);
        openPorts.delete(portId);

        return background?.executeJavaScript(
            `window.__vcIabPortGone ? window.__vcIabPortGone(${JSON.stringify(portId)}) : null`
        ) ?? null;
    });

    const pagePorts = new Map<string, Electron.WebContents>();

    electron.ipcMain.handle("vc-iab-ext-connect", (event, extensionId: string, portId: string, name: string, url: string, origin: string) => {
        const background = backgroundFor(extensionId);
        if (!background) throw new Error("No background page for this extension.");

        pagePorts.set(portId, event.sender);
        event.sender.once("destroyed", () => pagePorts.delete(portId));

        const sender = { url, origin, frameId: 0 };

        return background.executeJavaScript(
            `window.__vcIabConnect ? window.__vcIabConnect(${JSON.stringify(portId)}, ${JSON.stringify(name)}, ${JSON.stringify(sender)}) : null`
        );
    });

    electron.ipcMain.handle("vc-iab-ext-port", (_event, extensionId: string, portId: string, message: unknown) => {
        return backgroundFor(extensionId)?.executeJavaScript(
            `window.__vcIabPortIn ? window.__vcIabPortIn(${JSON.stringify(portId)}, ${JSON.stringify(message)}) : null`
        ) ?? null;
    });

    electron.ipcMain.handle("vc-iab-ext-port-close", (_event, extensionId: string, portId: string) => {
        pagePorts.delete(portId);

        return backgroundFor(extensionId)?.executeJavaScript(
            `window.__vcIabPortGone ? window.__vcIabPortGone(${JSON.stringify(portId)}) : null`
        ) ?? null;
    });

    electron.ipcMain.handle("vc-iab-background-port", (_event, portId: string, kind: string, message: unknown) => {
        const page = pagePorts.get(portId);
        if (page && !page.isDestroyed()) {
            if (kind === "close") {
                pagePorts.delete(portId);
                page.send("vc-iab-ext-port-closed", portId);
            } else {
                page.send("vc-iab-ext-port-in", portId, message);
            }

            return null;
        }

        const entry = openPorts.get(portId);
        if (!entry || entry.guest.isDestroyed()) return null;

        if (kind === "close") {
            openPorts.delete(portId);
            entry.guest.send("vc-iab-port-closed", portId);
        } else {
            entry.guest.send("vc-iab-port-to-world", portId, message);
        }

        return null;
    });

    electron.ipcMain.handle("vc-iab-ext-broadcast", async (event, extensionId: string, message: unknown, url: string, origin: string) => {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        if (!extension) return null;

        const prefix = `chrome-extension://${extension.id}/`;
        const sender = { url, origin, frameId: 0 };
        const pages = webContents.getAllWebContents().filter(contents => !contents.isDestroyed()
            && contents.getURL().startsWith(prefix));
        const targets = [
            ...pages.filter(contents => contents.id === event.sender.id),
            ...pages.filter(contents => contents.id !== event.sender.id)
        ];

        for (const target of targets) {
            const answer = await target.executeJavaScript(
                `window.__vcIabDispatch ? window.__vcIabDispatch(${JSON.stringify(message)}, ${JSON.stringify(sender)}) : null`
            ).catch(() => null);

            if (answer !== null && answer !== undefined) return answer;
        }

        return null;
    });

    electron.ipcMain.handle("vc-iab-ext-message", (_event, extensionId: string, message: unknown, url: string, origin: string) => {
        const background = backgroundFor(extensionId);
        if (!background) throw new Error("No background page for this extension.");

        const sender = { url, origin, frameId: 0 };

        return background.executeJavaScript(
            `window.__vcIabDispatch ? window.__vcIabDispatch(${JSON.stringify(message)}, ${JSON.stringify(sender)}) : null`
        );
    });

    electron.ipcMain.handle("vc-iab-user-script-message", async (event, extensionId: string, message: unknown, sender: any) => {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        if (!extension) throw new Error("Unknown extension.");

        const background = webContents.getAllWebContents()
            .find(contents => !contents.isDestroyed() && contents.getURL().startsWith(`chrome-extension://${extension.id}/${BG_PAGE}`));

        if (!background) throw new Error("No background page for this extension.");

        const stamped = { ...sender, tabId: event.sender.id };

        return background.executeJavaScript(
            `window.__vcIabDispatch ? window.__vcIabDispatch(${JSON.stringify(message)}, ${JSON.stringify(stamped)}) : null`
        );
    });
}

function writeExtensionShim() {
    const allowed = Object.fromEntries(loadedExtensions
        .filter(extension => grantedStoreIds.has(extension.storeId))
        .map(extension => [extension.id, true]));

    const registrations = [...userScriptsByExtension.entries()]
        .filter(([extensionId]) => allowed[extensionId] === true)
        .map(([extensionId, scripts], index) => ({ extensionId, scripts, world: USER_SCRIPT_WORLD + index }));

    writeFileSync(SHIM_PATH, `
const source = ${JSON.stringify(SHIM_SOURCE)};
const userScripts = ${JSON.stringify(USER_SCRIPTS_SOURCE)};
const allowed = ${JSON.stringify(allowed)};
const dispatchSource = ${JSON.stringify(DISPATCH_SOURCE)};
const registrations = ${JSON.stringify(registrations)};
const moduleWorkerIds = ${JSON.stringify(loadedExtensions
        .filter(extension => moduleWorkers.has(join(EXTENSIONS_DIR, extension.storeId)))
        .map(extension => extension.id))};
const SW_WRAPPER = ${JSON.stringify(SW_WRAPPER)};
const hostedBackgroundIds = ${JSON.stringify(loadedExtensions
        .filter(extension => extension.backgroundPage !== null)
        .map(extension => extension.id))};
const USER_SCRIPT_WORLD = ${USER_SCRIPT_WORLD};
const USER_SCRIPT_CSP = ${JSON.stringify(USER_SCRIPT_CSP)};

try {
    const { ipcRenderer, webFrame } = require("electron");
    const extensionId = location.protocol === "chrome-extension:" ? location.hostname : null;

    window.addEventListener("message", async event => {
        const data = event.data;
        if (event.source !== window) return;

        if (data?.__vcIab === "tabs-create") {
            ipcRenderer.sendToHost("vc-iab-open-tab", data.url);
            return;
        }

        if (data?.__vcIab === "tabs-update" || data?.__vcIab === "tabs-remove") {
            ipcRenderer.sendToHost("vc-iab-tabs", data);
            return;
        }

        if (data?.__vcIab === "ext-connect") {
            ipcRenderer.invoke("vc-iab-ext-connect", extensionId, data.portId, data.name, location.href, location.origin).catch(() => { });
            return;
        }

        if (data?.__vcIab === "ext-port") {
            ipcRenderer.invoke("vc-iab-ext-port", extensionId, data.portId, data.message).catch(() => { });
            return;
        }

        if (data?.__vcIab === "ext-port-close") {
            ipcRenderer.invoke("vc-iab-ext-port-close", extensionId, data.portId).catch(() => { });
            return;
        }

        if (data?.__vcIab === "inject") {
            let result = null;

            try {
                result = await ipcRenderer.invoke(data.channel, extensionId, data.tabId, data.details);
            } catch {
                result = null;
            }

            window.postMessage({ __vcIab: "inject-reply", id: data.id, result }, "*");
            return;
        }

        if (data?.__vcIab === "webrequest-register") {
            ipcRenderer.invoke("vc-iab-webrequest-register").catch(() => { });
            return;
        }

        if (data?.__vcIab === "webrequest-result") {
            ipcRenderer.send("vc-iab-webrequest-reply", data.id, data.result);
            return;
        }

        if (data?.__vcIab === "ext-message") {
            const channel = data.fromBackground ? "vc-iab-ext-broadcast" : "vc-iab-ext-message";
            let result = null;

            try {
                result = await ipcRenderer.invoke(channel, extensionId, data.message, location.href, location.origin);
            } catch {
                result = null;
            }

            window.postMessage({ __vcIab: "ext-reply", id: data.id, result }, "*");
            return;
        }

        if (data?.__vcIab !== "user-scripts") return;

        try {
            const result = await ipcRenderer.invoke("vc-iab-user-scripts", extensionId, data.method, data.payload);
            window.postMessage({ __vcIab: "reply", id: data.id, result }, "*");
        } catch (error) {
            window.postMessage({ __vcIab: "reply", id: data.id, error: String(error) }, "*");
        }
    });

    ipcRenderer.on("vc-iab-ext-event", (_event, kind, payload) => {
        window.postMessage({ __vcIab: "ext-event", kind, payload }, "*");
    });

    ipcRenderer.on("vc-iab-ext-port-in", (_event, portId, message) => {
        window.postMessage({ __vcIab: "ext-port-in", portId, message }, "*");
    });
    ipcRenderer.on("vc-iab-ext-port-closed", (_event, portId) => {
        window.postMessage({ __vcIab: "ext-port-closed", portId }, "*");
    });

    ipcRenderer.on("vc-iab-webrequest", (_event, id, event, details) => {
        window.postMessage({ __vcIab: "webrequest-run", id, event, details }, "*");
    });

    let seeded = [];
    try {
        seeded = ipcRenderer.sendSync("vc-iab-tabs-now") || [];
    } catch {
        seeded = [];
    }

    const hosted = "window.__vcIabHosted = " + JSON.stringify(hostedBackgroundIds) + ";"
        + "window.__vcIabTabsSeed = " + JSON.stringify(seeded) + ";";

    webFrame.executeJavaScript(extensionId === null ? source : hosted + source + userScripts);

    if (extensionId !== null) {
        webFrame.executeJavaScript(dispatchSource);

        window.addEventListener("message", event => {
            const data = event.data;
            if (event.source !== window) return;

            if (data?.__vcIab === "bg-port-out") ipcRenderer.invoke("vc-iab-background-port", data.portId, "message", data.message).catch(() => { });
            if (data?.__vcIab === "bg-port-close") ipcRenderer.invoke("vc-iab-background-port", data.portId, "close", null).catch(() => { });
        });
    }
    else runUserScripts();

    function globMatch(glob, value) {
        if (glob.indexOf("*") === -1) return glob === value;

        const parts = glob.split("*");
        const first = parts[0];
        const last = parts[parts.length - 1];

        if (!value.startsWith(first) || !value.endsWith(last)) return false;
        if (first.length + last.length > value.length) return false;

        let index = first.length;
        for (let i = 1; i < parts.length - 1; i++) {
            const found = value.indexOf(parts[i], index);
            if (found === -1) return false;
            index = found + parts[i].length;
        }

        return true;
    }

    function patternApplies(pattern, parsed) {
        const scheme = parsed.protocol.slice(0, -1);
        if (pattern === "<all_urls>") return scheme === "http" || scheme === "https";

        const schemeEnd = pattern.indexOf("://");
        if (schemeEnd === -1) return false;

        const wanted = pattern.slice(0, schemeEnd);
        const rest = pattern.slice(schemeEnd + 3);
        const slash = rest.indexOf("/");
        if (slash === -1) return false;

        const host = rest.slice(0, slash);
        const path = rest.slice(slash);

        if (wanted === "*") {
            if (scheme !== "http" && scheme !== "https") return false;
        } else if (wanted !== scheme) return false;

        if (host !== "*") {
            if (host.startsWith("*.")) {
                const suffix = host.slice(2);
                if (parsed.hostname !== suffix && !parsed.hostname.endsWith("." + suffix)) return false;
            } else if (host !== parsed.hostname) return false;
        }

        return globMatch(path, parsed.pathname + parsed.search);
    }

    function scriptApplies(script, parsed) {
        if (!script.matches.some(pattern => patternApplies(pattern, parsed))) return false;
        return !script.excludeMatches.some(pattern => patternApplies(pattern, parsed));
    }

    function runUserScripts() {
        if (location.protocol !== "http:" && location.protocol !== "https:") return;

        const parsed = new URL(location.href);
        const jobs = [];

        for (const entry of registrations) {
            for (const script of entry.scripts) {
                if (!script.allFrames && window !== window.top) continue;
                if (scriptApplies(script, parsed)) jobs.push({ extensionId: entry.extensionId, world: entry.world, script });
            }
        }

        if (jobs.length === 0) return;

        jobs.sort((a, b) => a.script.id < b.script.id ? -1 : a.script.id > b.script.id ? 1 : 0);

        const worlds = [...new Set(jobs.map(job => job.world))];

        for (const world of worlds) {
            webFrame.setIsolatedWorldInfo(world, {
                securityOrigin: location.origin,
                name: "vc-iab-user-script-" + world,
                csp: USER_SCRIPT_CSP
            });
        }

        const pending = new Map();
        let seq = 0;

        const senderInfo = () => ({ url: location.href, origin: location.origin, frameId: 0 });
        const worldFor = extensionId => (registrations.find(entry => entry.extensionId === extensionId) || {}).world;
        const portWorlds = new Map();

        ipcRenderer.on("vc-iab-port-to-world", (_event, portId, message) => {
            const world = portWorlds.get(portId);
            if (world === undefined) return;

            runInWorld(world, "window.__vcIabPortMessage(" + JSON.stringify(portId) + "," + JSON.stringify(message) + ")", "port-in");
        });
        ipcRenderer.on("vc-iab-port-closed", (_event, portId) => {
            const world = portWorlds.get(portId);
            if (world === undefined) return;

            portWorlds.delete(portId);
            runInWorld(world, "window.__vcIabPortClosed(" + JSON.stringify(portId) + ")", "port-close");
        });

        window.addEventListener("message", async event => {
            const data = event.data;
            if (event.source !== window) return;

            if (data?.__vcIab === "user-script-connect") {
                portWorlds.set(data.portId, worldFor(data.extensionId));
                ipcRenderer.invoke("vc-iab-user-script-connect", data.extensionId, data.portId, data.name, senderInfo()).catch(() => { });
                return;
            }

            if (data?.__vcIab === "user-script-port") {
                ipcRenderer.invoke("vc-iab-user-script-port", data.extensionId, data.portId, data.message).catch(() => { });
                return;
            }

            if (data?.__vcIab === "user-script-port-close") {
                ipcRenderer.invoke("vc-iab-user-script-port-close", data.extensionId, data.portId).catch(() => { });
                return;
            }

            if (data?.__vcIab !== "user-script-runtime") return;

            let reply = null;
            let failure = null;
            try {
                reply = await ipcRenderer.invoke("vc-iab-user-script-message", data.extensionId, data.message, senderInfo());
            } catch (error) {
                failure = String(error);
            }

            runInWorld(worldFor(data.extensionId), "window.__vcIabUserScriptReply(" + JSON.stringify(data.id) + ","
                + JSON.stringify(reply) + "," + JSON.stringify(failure) + ")", "reply");
        });

        function runInWorld(world, code, label) {
            const note = message => console.error("[vc-iab] user script " + String(label) + " failed:", message);

            try {
                Promise.resolve(webFrame.executeJavaScriptInIsolatedWorld(world, [{ code }]))
                    .catch(error => note(String(error)));
            } catch (error) {
                note("sync " + String(error));
            }
        }

        const runtimeShim = extensionIdForShim => "(() => {"
            + "const pending = new Map(); const ports = new Map(); let seq = 0;"
            + "const ID = " + JSON.stringify(extensionIdForShim) + ";"
            + "window.__vcIabUserScriptReply = (id, result, error) => {"
            + "  const entry = pending.get(id); if (!entry) return; pending.delete(id);"
            + "  if (error) { entry.reject(new Error(error)); } else { entry.resolve(result); } };"
            + "window.__vcIabPortMessage = (portId, message) => {"
            + "  const port = ports.get(portId); if (!port) return;"
            + "  for (const listener of port.listeners) { try { listener(message); } catch (e) { console.error(e); } } };"
            + "window.__vcIabPortClosed = portId => {"
            + "  const port = ports.get(portId); if (!port) return; ports.delete(portId);"
            + "  for (const listener of port.disconnects) { try { listener(); } catch (e) { console.error(e); } } };"
            + "const send = message => new Promise((resolve, reject) => {"
            + "  const id = ++seq; pending.set(id, { resolve, reject });"
            + "  window.postMessage({ __vcIab: 'user-script-runtime', id, extensionId: ID, message }, '*'); });"
            + "const connect = info => {"
            + "  const portId = 'p' + (++seq); const name = (info && info.name) || '';"
            + "  const listeners = new Set(); const disconnects = new Set();"
            + "  ports.set(portId, { listeners, disconnects });"
            + "  window.postMessage({ __vcIab: 'user-script-connect', portId, extensionId: ID, name }, '*');"
            + "  return { name, sender: { id: ID, url: location.href },"
            + "    postMessage: message => window.postMessage({ __vcIab: 'user-script-port', portId, extensionId: ID, message }, '*'),"
            + "    onMessage: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l), hasListener: l => listeners.has(l) },"
            + "    onDisconnect: { addListener: l => disconnects.add(l), removeListener: l => disconnects.delete(l), hasListener: l => disconnects.has(l) },"
            + "    disconnect: () => { ports.delete(portId); window.postMessage({ __vcIab: 'user-script-port-close', portId, extensionId: ID }, '*'); } }; };"
            + "window.chrome = window.chrome || {};"
            + "window.chrome.runtime = Object.assign({}, window.chrome.runtime, {"
            + "  id: ID, connect,"
            + "  sendMessage: (...args) => {"
            + "    const message = args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0];"
            + "    const callback = args.find(a => typeof a === 'function');"
            + "    const promise = send(message);"
            + "    if (callback) { promise.then(callback, () => callback(undefined)); return; }"
            + "    return promise; },"
            + "  onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },"
            + "  onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },"
            + "  getURL: path => { const value = String(path); "
            + "    return 'chrome-extension://' + ID + '/' + (value.charAt(0) === '/' ? value.slice(1) : value); }"
            + "});"
            + "})();";

        const shimmed = new Set();

        const inject = when => {
            for (const job of jobs) {
                if (job.script.runAt !== when) continue;

                if (job.script.world === "MAIN") {
                    Promise.resolve(webFrame.executeJavaScript(job.script.code))
                        .catch(error => console.error("[vc-iab] user script " + job.script.id + " failed:", String(error)));
                    continue;
                }

                if (!shimmed.has(job.extensionId)) {
                    shimmed.add(job.extensionId);
                    runInWorld(job.world, runtimeShim(job.extensionId), "runtime shim");
                }

                runInWorld(job.world, job.script.code, job.script.id);
            }
        };

        inject("document_start");

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => { inject("document_end"); }, { once: true });
        } else {
            inject("document_end");
        }

        if (document.readyState === "complete") inject("document_idle");
        else window.addEventListener("load", () => { inject("document_idle"); }, { once: true });
    }
} catch {
    try { (0, eval)(source); } catch { /* the context blocks both, nothing else to try */ }
}
`);

}

function installExtensionShim() {
    writeExtensionShim();

    const browsing = session.fromPartition(PARTITION);

    for (const type of ["frame", "service-worker"] as const) {
        try {
            browsing.registerPreloadScript({ type, filePath: SHIM_PATH });
        } catch {}
    }
}

interface ExtensionInfo {
    id: string;
    storeId: string;
    name: string;
    version: string;
    optionsPage: string | null;
    popupPage: string | null;
    icon: string | null;
    backgroundPage: string | null;
}

const loadedExtensions: ExtensionInfo[] = [];
const extensionFailures: Array<{ folder: string; error: string; }> = [];

async function loadExtensions() {
    mkdirSync(EXTENSIONS_DIR, { recursive: true });

    const browsing = session.fromPartition(PARTITION);

    for (const entry of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const folder = join(EXTENSIONS_DIR, entry.name);
        if (!existsSync(join(folder, "manifest.json"))) continue;

        const backgroundPage = prepareBackground(folder);

        try {
            const extension = await browsing.extensions.loadExtension(folder, { allowFileAccess: true });
            loadedExtensions.push({
                id: extension.id,
                storeId: entry.name,
                name: extension.name,
                version: extension.manifest?.version ?? "",
                optionsPage: optionsPageOf(extension.manifest),
                popupPage: popupPageOf(extension.manifest),
                icon: iconOf(extension.manifest, folder),
                backgroundPage
            });
        } catch (error) {
            extensionFailures.push({ folder: entry.name, error: String(error).slice(0, 300) });
        }
    }
}

function withChromeBrand(value: string) {
    return value;
    //if (value.includes('"Google Chrome"')) return value;

    //const chromium = value.match(/"Chromium";v="([^"]+)"/);
    //if (!chromium) return value;

    //return value.replace(chromium[0], `"Google Chrome";v="${chromium[1]}", ${chromium[0]}`);
}

function browserUserAgent(userAgent: string) {
    return userAgent
        //.replace(/\s*discord\/\S+/gi, "")
        //.replace(/\s*Electron\/\S+/gi, "")
        //.replace(/\s{2,}/g, " ")
        //.trim();
}

function pluginSettings() {
    try {
        const { RendererSettings } = require("@main/settings");
        return RendererSettings.store.plugins?.InAppBrowser ?? {};
    } catch {
        return {};
    }
}

function isEnabled() {
    return pluginSettings().enabled === true;
}

if (isEnabled()) {
    if (pluginSettings().mediaKeys !== false) {
        const MEDIA_FEATURES = ["HardwareMediaKeyHandling", "MediaSessionService"];

        const originalAppend = electron.app.commandLine.appendSwitch;
        electron.app.commandLine.appendSwitch = function (...args: [string, string?]) {
            if (args[0] === "disable-features" && typeof args[1] === "string") {
                args[1] = args[1].split(",").filter(feature => !MEDIA_FEATURES.includes(feature.trim())).join(",");
            }

            if (args[0] === "enable-features") {
                const merged = new Set((args[1] ?? "").split(",").filter(Boolean));
                for (const feature of MEDIA_FEATURES) merged.add(feature);
                args[1] = [...merged].join(",");
            }

            return originalAppend.apply(this, args);
        };

        const existing = electron.app.commandLine.getSwitchValue("enable-features");
        const features = new Set(existing ? existing.split(",").filter(Boolean) : []);
        for (const feature of MEDIA_FEATURES) features.add(feature);
        electron.app.commandLine.appendSwitch("enable-features", [...features].join(","));
    }

    const Base = electron.BrowserWindow;

    class BrowserWindow extends Base {
        constructor(options: Electron.BrowserWindowConstructorOptions) {
            if (options?.webPreferences) options.webPreferences.webviewTag = true;
            super(options);
        }
    }

    Object.assign(BrowserWindow, Base);
    Object.defineProperty(BrowserWindow, "name", { value: "BrowserWindow", configurable: true });

    const entry = require.cache[require.resolve("electron")];
    if (entry) {
        delete entry.exports;
        entry.exports = { ...electron, BrowserWindow };
    }

    const { buildFromTemplate } = Menu;
    Menu.buildFromTemplate = template => buildFromTemplate(retargetDevTools(template));

    electron.app.whenReady().then(() => {
        const browsing = session.fromPartition(PARTITION);
        browsing.setUserAgent(browserUserAgent(browsing.getUserAgent()));
        loadUserScriptGrants();
        registerUserScriptChannels();
        registerNetworkBridge();
        registerInjectionChannels();
        installExtensionShim();
        loadExtensions().then(writeExtensionShim);

        browsing.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = details.requestHeaders;

            for (const key of Object.keys(headers)) {
                const name = key.toLowerCase();
                if (name === "sec-ch-ua" || name === "sec-ch-ua-full-version-list") {
                    headers[key] = withChromeBrand(String(headers[key]));
                }
            }

            callback({ requestHeaders: headers });
        });
    });

    electron.app.on("web-contents-created", (_event, contents) => {
        const target = contents as unknown as { getZoomFactor?: () => number; };
        if (typeof target.getZoomFactor !== "function") target.getZoomFactor = () => 1;

        if (contents.getType() !== "webview") return;

        contents.setUserAgent(browserUserAgent(contents.getUserAgent()));

        contents.on("context-menu", (_contextEvent, params) => {
            const history = contents.navigationHistory;
            const template: Electron.MenuItemConstructorOptions[] = [];

            if (params.linkURL) {
                template.push(
                    { label: "Open link", click: () => contents.loadURL(params.linkURL) },
                    { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
                    { type: "separator" }
                );
            }

            if (params.mediaType === "image" && params.srcURL) {
                template.push(
                    { label: "Open image", click: () => contents.loadURL(params.srcURL) },
                    { label: "Copy image address", click: () => clipboard.writeText(params.srcURL) },
                    { type: "separator" }
                );
            }

            if (params.isEditable) {
                template.push(
                    { label: "Undo", enabled: params.editFlags.canUndo, click: () => contents.undo() },
                    { label: "Redo", enabled: params.editFlags.canRedo, click: () => contents.redo() },
                    { type: "separator" },
                    { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
                    { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
                    { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
                    { type: "separator" }
                );
            } else if (params.selectionText) {
                template.push(
                    { label: "Copy", click: () => contents.copy() },
                    { type: "separator" }
                );
            }

            template.push(
                { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
                { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
                { label: "Reload", click: () => contents.reload() },
                { type: "separator" },
                { label: "Select all", click: () => contents.selectAll() },
                { label: "Open in default browser", click: () => shell.openExternal(params.pageURL) },
                { type: "separator" },
                { label: "Inspect element", click: () => contents.inspectElement(params.x, params.y) }
            );

            Menu.buildFromTemplate(template).popup({ window: electron.BrowserWindow.getFocusedWindow() ?? undefined });
        });

        contents.setWindowOpenHandler(({ url }) => {
            if (isWebUrl(url)) contents.loadURL(url);
            return { action: "deny" };
        });
        contents.on("will-navigate", (event, url) => {
            if (!isWebUrl(url) && !url.startsWith("chrome-extension://")) event.preventDefault();
        });
    });
}

let activeGuestId: number | null = null;

export function setActiveGuest(_: IpcMainInvokeEvent, webContentsId: number | null) {
    activeGuestId = webContentsId;
}

function devToolsTarget() {
    const guest = activeGuestId === null ? null : webContents.fromId(activeGuestId);
    if (guest && !guest.isDestroyed()) return guest;

    return electron.BrowserWindow.getFocusedWindow()?.webContents;
}

type MenuTemplate = Array<Electron.MenuItemConstructorOptions | MenuItem>;

function retargetDevTools(template: MenuTemplate) {
    for (const item of template) {
        if (item instanceof MenuItem) continue;
        if (Array.isArray(item.submenu)) retargetDevTools(item.submenu);
        if (item.role !== "toggleDevTools") continue;

        delete item.role;
        item.label ??= "Toggle Developer Tools";
        item.accelerator ??= process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I";
        item.click = () => devToolsTarget()?.toggleDevTools();
    }

    return template;
}

function isWebUrl(target: string) {
    try {
        const { protocol } = new URL(target);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

export async function fetchFavicon(_: IpcMainInvokeEvent, url: string): Promise<string | null> {
    if (typeof url !== "string" || !isWebUrl(url)) return null;

    try {
        const response = await session.fromPartition(PARTITION).fetch(url);
        const type = response.headers.get("content-type") ?? "image/png";
        if (!response.ok || !type.startsWith("image/")) return null;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_FAVICON_BYTES) return null;

        return `data:${type};base64,${buffer.toString("base64")}`;
    } catch {
        return null;
    }
}

export async function setFrozen(_: IpcMainInvokeEvent, webContentsId: number, frozen: boolean) {
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed() || contents.getType() !== "webview") return false;
    if (frozen && contents.isCurrentlyAudible()) return false;

    try {
        if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
            await contents.debugger.sendCommand("Page.enable");
        }

        await contents.debugger.sendCommand("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
        return true;
    } catch {
        return false;
    }
}

const CRX_MAGIC = 0x43723234;
const MAX_CRX_BYTES = 100 * 1024 * 1024;

function popupPageOf(manifest: any) {
    const page = manifest?.action?.default_popup ?? manifest?.browser_action?.default_popup;
    return typeof page === "string" && page.length > 0 ? page : null;
}

function iconOf(manifest: any, folder: string) {
    const icons = manifest?.icons ?? manifest?.action?.default_icon ?? manifest?.browser_action?.default_icon;
    const sizes = typeof icons === "object" && icons !== null
        ? Object.entries(icons).sort((a, b) => Number(a[0]) - Number(b[0]))
        : [];
    const relative = typeof icons === "string"
        ? icons
        : (sizes.find(([size]) => Number(size) >= 32) ?? sizes[sizes.length - 1])?.[1];

    if (typeof relative !== "string") return null;

    const file = normalizePath(join(folder, relative));
    if (!file.startsWith(normalizePath(folder))) return null;

    try {
        const type = file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".jpg") ? "image/jpeg" : "image/png";
        return `data:${type};base64,${readFileSync(file).toString("base64")}`;
    } catch {
        return null;
    }
}

function optionsPageOf(manifest: any) {
    const page = manifest?.options_ui?.page ?? manifest?.options_page;
    return typeof page === "string" && page.length > 0 ? page : null;
}

function crxToZip(buffer: Buffer) {
    if (buffer.length < 16 || buffer.readUInt32BE(0) !== CRX_MAGIC) return null;

    const version = buffer.readUInt32LE(4);

    if (version === 2) {
        const publicKeyLength = buffer.readUInt32LE(8);
        const signatureLength = buffer.readUInt32LE(12);
        return buffer.subarray(16 + publicKeyLength + signatureLength);
    }

    if (version === 3) return buffer.subarray(12 + buffer.readUInt32LE(8));

    return null;
}

export async function installExtension(_: IpcMainInvokeEvent, extensionId: string) {
    if (!/^[a-p]{32}$/.test(extensionId)) return { ok: false, error: "That doesn't look like an extension id." };

    const url = "https://clients2.google.com/service/update2/crx?response=redirect"
        + `&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3`
        + `&x=id%3D${extensionId}%26uc`;

    try {
        const response = await session.fromPartition(INSTALLER_PARTITION).fetch(url);
        const browsing = session.fromPartition(PARTITION);
        if (!response.ok) return { ok: false, error: `The store returned ${response.status}.` };

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_CRX_BYTES) return { ok: false, error: "That extension is too large." };

        const zip = crxToZip(buffer);
        if (!zip) return { ok: false, error: "That download wasn't a Chrome extension." };

        const folder = join(EXTENSIONS_DIR, extensionId);
        rmSync(folder, { recursive: true, force: true });

        for (const [name, data] of Object.entries(unzipSync(new Uint8Array(zip)))) {
            if (name.endsWith("/") || name.startsWith("_metadata/")) continue;

            const target = normalizePath(join(folder, name));
            if (!target.startsWith(folder)) continue;

            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, data);
        }

        const existing = loadedExtensions.findIndex(e => e.storeId === extensionId);
        if (existing !== -1) {
            browsing.extensions.removeExtension(loadedExtensions[existing].id);
            loadedExtensions.splice(existing, 1);
        }

        const extension = await browsing.extensions.loadExtension(folder, { allowFileAccess: true });
        loadedExtensions.push({
            id: extension.id,
            storeId: extensionId,
            name: extension.name,
            version: extension.manifest?.version ?? "",
            optionsPage: optionsPageOf(extension.manifest),
            popupPage: popupPageOf(extension.manifest),
            icon: iconOf(extension.manifest, folder),
            backgroundPage: prepareBackground(folder)
        });

        return { ok: true, name: extension.name };
    } catch (error) {
        return { ok: false, error: String(error).slice(0, 200) };
    }
}

export function getExtensions(_: IpcMainInvokeEvent) {
    mkdirSync(EXTENSIONS_DIR, { recursive: true });

    const folders = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const loaded = loadedExtensions.find(extension => extension.storeId === entry.name);
            const failure = extensionFailures.find(item => item.folder === entry.name);

            return {
                storeId: entry.name,
                name: loaded?.name ?? entry.name,
                version: loaded?.version ?? "",
                loaded: loaded !== undefined,
                error: failure?.error ?? null,
                optionsUrl: loaded?.optionsPage ? `chrome-extension://${loaded.id}/${loaded.optionsPage}` : null,
                popupUrl: loaded?.popupPage ? `chrome-extension://${loaded.id}/${loaded.popupPage}` : null,
                icon: loaded?.icon ?? null,
                userScripts: grantedStoreIds.has(entry.name)
            };
        });

    return { directory: EXTENSIONS_DIR, extensions: folders };
}

export function removeExtension(_: IpcMainInvokeEvent, storeId: string) {
    if (!/^[\w.-]{1,64}$/.test(storeId)) return { ok: false, error: "That isn't a valid extension folder." };

    const folder = join(EXTENSIONS_DIR, storeId);
    if (normalizePath(folder) !== folder || !existsSync(folder)) return { ok: false, error: "That extension is not installed." };

    const index = loadedExtensions.findIndex(extension => extension.storeId === storeId);
    if (index !== -1) {
        try {
            session.fromPartition(PARTITION).extensions.removeExtension(loadedExtensions[index].id);
        } catch {

        }
        loadedExtensions.splice(index, 1);
    }

    try {
        rmSync(folder, { recursive: true, force: true });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error).slice(0, 200) };
    }
}

export function openExtensionsFolder(_: IpcMainInvokeEvent) {
    mkdirSync(EXTENSIONS_DIR, { recursive: true });
    shell.openPath(EXTENSIONS_DIR);
}

export function getBackgroundPages(_: IpcMainInvokeEvent) {
    return loadedExtensions
        .filter(extension => extension.backgroundPage !== null)
        .map(extension => ({
            id: extension.id,
            name: extension.name,
            url: `chrome-extension://${extension.id}/${extension.backgroundPage}`
        }));
}
