/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import electron, { clipboard, type IpcMainInvokeEvent, Menu, session, shell, webContents } from "electron";
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

/**
 * Electron's service worker preloads never reach extension service workers, so a
 * manifest v3 background worker still dies on the missing namespaces. Point the
 * manifest at a wrapper that installs the shim and then loads the real worker.
 */
function shimServiceWorker(folder: string) {
    const manifestPath = join(folder, "manifest.json");

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const worker = manifest.background?.service_worker;
        if (typeof worker !== "string" || worker === SW_WRAPPER) return;

        const load = manifest.background.type === "module"
            ? `import("./${worker}");`
            : `importScripts("${worker}");`;

        writeFileSync(join(folder, SW_WRAPPER), `
(() => {
    const boot = () => {
        if (typeof chrome === "undefined" || chrome === null) return false;
        ${SHIM_SOURCE}
        ${load}
        return true;
    };

    if (boot()) return;

    const timer = setInterval(() => { if (boot()) clearInterval(timer); }, 20);
    setTimeout(() => clearInterval(timer), 10000);
})();
`);

        manifest.background.service_worker = SW_WRAPPER;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
        // a malformed manifest will fail loudly at loadExtension instead
    }
}

/**
 * Electron has no extension toolbar, so chrome.action / chrome.browserAction and
 * chrome.commands are undefined. Extensions that touch them while starting up
 * (uBlock Origin calls action.setBadgeBackgroundColor) throw and never finish
 * initialising, which leaves their options pages spinning forever. Stub the
 * namespaces so those calls become harmless no-ops.
 */
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

function installExtensionShim() {
    writeFileSync(SHIM_PATH, `
const source = ${JSON.stringify(SHIM_SOURCE)};

try {
    require("electron").webFrame.executeJavaScript(source);
} catch {
    try { (0, eval)(source); } catch { /* the context blocks both, nothing else to try */ }
}
`);

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

        shimServiceWorker(folder);

        try {
            const extension = await browsing.extensions.loadExtension(folder, { allowFileAccess: true });
            loadedExtensions.push({
                id: extension.id,
                storeId: entry.name,
                name: extension.name,
                version: extension.manifest?.version ?? "",
                optionsPage: optionsPageOf(extension.manifest)
            });
        } catch (error) {
            extensionFailures.push({ folder: entry.name, error: String(error).slice(0, 300) });
        }
    }
}

/**
 * Discord's user agent carries discord/x and Electron/x tokens, which many sites
 * treat as a bot signal. Strip them so requests look like the Chrome build this
 * really is, keeping the genuine Chrome version rather than inventing one.
 */
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

/**
 * <webview> is the only way to embed a page inside Discord's DOM, so Discord's
 * modals and menus stack above it. It needs webviewTag at window construction,
 * and Discord's Electron build is missing WebContents#getZoomFactor, which the
 * guest view manager calls while attaching the guest.
 */
if (isEnabled()) {
    /**
     * Electron leaves Chromium's media session off, so audio in a tab never
     * reaches the OS now playing controls or the keyboard's media keys. Merge the
     * features in rather than assigning, so any that Discord already set survive.
     * Chromium maps this onto each platform itself: Now Playing on macOS, SMTC on
     * Windows, MPRIS on Linux.
     */
    if (pluginSettings().mediaKeys !== false) {
        const MEDIA_FEATURES = ["HardwareMediaKeyHandling", "MediaSessionService"];

        // Discord disables these, and in Chromium disable-features beats
        // enable-features, so strip them from its call before enabling them.
        const originalAppend = electron.app.commandLine.appendSwitch;
        electron.app.commandLine.appendSwitch = function (...args: [string, string?]) {
            if (args[0] === "disable-features" && typeof args[1] === "string") {
                args[1] = args[1].split(",").filter(feature => !MEDIA_FEATURES.includes(feature.trim())).join(",");
            }

            // appending the same switch replaces it, so fold ours into every call
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

    electron.app.whenReady().then(() => {
        const browsing = session.fromPartition(PARTITION);
        browsing.setUserAgent(browserUserAgent(browsing.getUserAgent()));
        installExtensionShim();
        loadExtensions();

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
                { label: "Open in default browser", click: () => shell.openExternal(params.pageURL) }
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

export function setFrozen(_: IpcMainInvokeEvent, webContentsId: number, frozen: boolean) {
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed() || contents.getType() !== "webview") return false;
    if (frozen && contents.isCurrentlyAudible()) return false;

    try {
        if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
            contents.debugger.sendCommand("Page.enable");
        }

        contents.debugger.sendCommand("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
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
        // Fetch through a session with no extensions loaded: an installed ad
        // blocker will otherwise block the store download.
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
            optionsPage: optionsPageOf(extension.manifest)
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
                optionsUrl: loaded?.optionsPage ? `chrome-extension://${loaded.id}/${loaded.optionsPage}` : null
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
            // already unloaded, the folder still needs to go
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
