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
const shimStatus: Record<string, string> = {};
const SW_WRAPPER = "vc-iab-service-worker.js";
const BG_PAGE = "vc-iab-background.html";
const BG_SHIM = "vc-iab-background-shim.js";
const USER_SCRIPTS_DIR = "vc-iab-userscripts";
const USER_SCRIPTS_FILE = join(DATA_DIR, "browserExtensionUserScripts.json");

const USER_SCRIPTS_SOURCE = `
(() => {
    const PREFIX = "vc-iab-us-";
    const pending = new Map();
    let seq = 0;

    window.addEventListener("message", event => {
        const data = event.data;
        if (event.source !== window || data?.__vcIab !== "reply" || !pending.has(data.id)) return;

        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? reject(new Error(data.error)) : resolve(data.result);
    });

    const stage = scripts => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        window.postMessage({ __vcIab: "stage", id, scripts }, "*");
    });

    const codeOf = js => (js ?? []).map(part => part?.code).filter(Boolean).join("\\n;\\n");
    const filesOf = js => (js ?? []).map(part => part?.file).filter(Boolean);
    const mine = async () => (await chrome.scripting.getRegisteredContentScripts())
        .filter(script => script.id.startsWith(PREFIX));

    const toContentScript = (script, staged) => ({
        id: PREFIX + script.id,
        js: staged.files,
        matches: script.matches,
        excludeMatches: script.excludeMatches,
        allFrames: !!script.allFrames,
        runAt: script.runAt ?? "document_idle",
        world: "MAIN"
    });

    const prepare = async scripts => {
        const staged = await stage(scripts.map(script => ({
            id: script.id, code: codeOf(script.js), files: filesOf(script.js)
        })));
        return scripts.map((script, index) => toContentScript(script, staged[index]));
    };

    const install = () => {
        if (typeof chrome === "undefined" || chrome === null || !chrome.scripting) return false;

        chrome.userScripts = {
            async register(scripts) {
                await chrome.scripting.registerContentScripts(await prepare(scripts));
            },
            async update(scripts) {
                await chrome.scripting.updateContentScripts(await prepare(scripts));
            },
            async unregister(filter) {
                const ids = filter?.ids
                    ? filter.ids.map(id => PREFIX + id)
                    : (await mine()).map(script => script.id);

                if (ids.length > 0) await chrome.scripting.unregisterContentScripts({ ids });
            },
            async getScripts(filter) {
                return (await mine())
                    .map(script => ({ ...script, id: script.id.slice(PREFIX.length) }))
                    .filter(script => !filter?.ids || filter.ids.includes(script.id));
            },
            async execute(injection) {
                const [staged] = await stage([{
                    id: "execute-" + Date.now(), code: codeOf(injection.js), files: filesOf(injection.js)
                }]);
                return chrome.scripting.executeScript({ target: injection.target, files: staged.files, world: "MAIN" });
            },
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

        if (background.service_worker !== worker) {
            background.service_worker = worker;
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }
        rmSync(join(folder, SW_WRAPPER), { force: true });

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
    try {
        const wrapper = readFileSync(join(folder, SW_WRAPPER), "utf8");
        const match = /import\("\.\/(.+?)"\)|importScripts\("(.+?)"\)/.exec(wrapper);
        return match?.[1] ?? match?.[2] ?? null;
    } catch {
        return null;
    }
}

const SHIM_SOURCE = `
(() => {
    const install = () => {
        if (typeof chrome === "undefined" || chrome === null) return false;

        const noop = () => {};
        const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });
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

        const tabListeners = new Set();

        window.__vcIabTabs = {
            emit(payload) {
                for (const listener of tabListeners) {
                    try {
                        listener(payload.id, payload.changeInfo, payload.tab);
                    } catch (error) {
                        console.error("[vc-iab] tabs.onUpdated listener failed", error);
                    }
                }
            }
        };

        if (chrome.tabs != null) {
            chrome.tabs.onUpdated = {
                addListener: listener => tabListeners.add(listener),
                removeListener: listener => tabListeners.delete(listener),
                hasListener: listener => tabListeners.has(listener)
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

        if (!chrome.webNavigation) {
            chrome.webNavigation = {
                onBeforeNavigate: event(),
                onCommitted: event(),
                onDOMContentLoaded: event(),
                onCompleted: event(),
                onHistoryStateUpdated: event(),
                onReferenceFragmentUpdated: event(),
                onCreatedNavigationTarget: event()
            };
        }

        if (!chrome.windows) {
            chrome.windows = {
                WINDOW_ID_NONE: -1,
                WINDOW_ID_CURRENT: -2,
                get: settle(null),
                getCurrent: settle(null),
                getLastFocused: settle(null),
                getAll: settle([]),
                create: settle(null),
                update: settle(null),
                remove: settle(),
                onCreated: event(),
                onRemoved: event(),
                onFocusChanged: event()
            };
        }

        if (!chrome.permissions) {
            chrome.permissions = {
                contains: settle(true),
                getAll: settle({ permissions: [], origins: [] }),
                request: settle(false),
                remove: settle(false),
                onAdded: event(),
                onRemoved: event()
            };
        }

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

function registerUserScriptStaging() {
    electron.ipcMain.handle("vc-iab-stage-user-scripts", (_event, extensionId: string, scripts: unknown) => {
        const extension = loadedExtensions.find(item => item.id === extensionId);
        if (!extension) throw new Error("Unknown extension.");
        if (!grantedStoreIds.has(extension.storeId)) throw new Error("User scripts are not allowed for this extension.");
        if (!Array.isArray(scripts)) throw new Error("Expected a list of scripts.");

        const directory = join(EXTENSIONS_DIR, extension.storeId, USER_SCRIPTS_DIR);
        mkdirSync(directory, { recursive: true });

        return scripts.map((script: any) => {
            const files = Array.isArray(script?.files) ? script.files.filter((file: unknown) => typeof file === "string") : [];

            if (typeof script?.code === "string" && script.code.length > 0) {
                const name = `${String(script.id ?? "script").replace(/[^a-z0-9_-]/gi, "_").slice(0, 80)}.js`;
                const target = normalizePath(join(directory, name));
                if (!target.startsWith(normalizePath(directory))) throw new Error("Rejected script name.");

                writeFileSync(target, script.code);
                files.unshift(`${USER_SCRIPTS_DIR}/${name}`);
            }

            return { id: script?.id, files };
        });
    });
}

function writeExtensionShim() {
    const allowed = Object.fromEntries(loadedExtensions
        .filter(extension => grantedStoreIds.has(extension.storeId))
        .map(extension => [extension.id, true]));

    writeFileSync(SHIM_PATH, `
const source = ${JSON.stringify(SHIM_SOURCE)};
const userScripts = ${JSON.stringify(USER_SCRIPTS_SOURCE)};
const allowed = ${JSON.stringify(allowed)};

try {
    const { ipcRenderer, webFrame } = require("electron");
    const extensionId = location.protocol === "chrome-extension:" ? location.hostname : null;

    const scriptsAllowed = extensionId !== null && allowed[extensionId] === true;

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

        if (data?.__vcIab !== "stage" || !scriptsAllowed) return;

        try {
            const result = await ipcRenderer.invoke("vc-iab-stage-user-scripts", extensionId, data.scripts);
            window.postMessage({ __vcIab: "reply", id: data.id, result }, "*");
        } catch (error) {
            window.postMessage({ __vcIab: "reply", id: data.id, error: String(error) }, "*");
        }
    });

    webFrame.executeJavaScript(scriptsAllowed ? source + userScripts : source);
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
            shimStatus[type] = "registered";
        } catch (error) {
            shimStatus[type] = String(error).slice(0, 160);
        }
    }

    return shimStatus;
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
    if (value.includes('"Google Chrome"')) return value;

    const chromium = value.match(/"Chromium";v="([^"]+)"/);
    if (!chromium) return value;

    return value.replace(chromium[0], `"Google Chrome";v="${chromium[1]}", ${chromium[0]}`);
}

function browserUserAgent(userAgent: string) {
    return userAgent
        .replace(/\s*discord\/\S+/gi, "")
        .replace(/\s*Electron\/\S+/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
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
        registerUserScriptStaging();
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

export function isAudible(_: IpcMainInvokeEvent, webContentsId: number) {
    const contents = webContents.fromId(webContentsId);
    return !!contents && !contents.isDestroyed() && contents.isCurrentlyAudible();
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
