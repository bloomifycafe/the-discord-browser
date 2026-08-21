/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelRouter, FluxDispatcher, NavigationRouter, React, showToast, Toasts, useStateFromStores } from "@webpack/common";

export const PARTITION = "persist:vc-in-app-browser";

const BROWSER_ROUTE = "/vc-in-app-browser";
const BROWSER_LABEL = "Browser";
const TABS_EXPERIMENT = "2026-07-desktop-channel-tabs";

interface TabEntry {
    kind: "channel" | "route";
    channelId?: string;
    guildId?: string | null;
    routePath?: string;
    routeLabel?: string;
}

interface Tab extends TabEntry {
    id: string;
    entries: TabEntry[];
    index: number;
}

interface ChannelTabsStoreShape {
    isEnabled(): boolean;
    isUserOptedIn(): boolean;
    getTabs(): Tab[];
    getActiveTab(): Tab | null;
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
}

const ChannelTabsStore: ChannelTabsStoreShape = findStoreLazy("ChannelTabsStore");

const Native = VencordNative.pluginHelpers.InAppBrowser as PluginNative<typeof import("./native")>;

export const settings = definePluginSettings({
    enableTabs: {
        type: OptionType.BOOLEAN,
        description: "Turn on Discord's channel tabs experiment automatically, since browser tabs are built on it.",
        default: true
    },
    homepage: {
        type: OptionType.STRING,
        description: "Page that new browser tabs start on.",
        default: "https://duckduckgo.com"
    },
    hideServerList: {
        type: OptionType.BOOLEAN,
        description: "Also hide the server list while browsing, for a full width page.",
        default: true
    },
    headerButton: {
        type: OptionType.BOOLEAN,
        description: "Show a browser button in the top bar that turns the current tab into a browser.",
        default: false
    },
    openLinksInTabs: {
        type: OptionType.BOOLEAN,
        description: "Open links from Discord in a browser tab instead of your default browser.",
        default: true
    },
    mediaKeys: {
        type: OptionType.BOOLEAN,
        description: "Expose browser tab audio to the system media controls and media keys. Needs a restart.",
        default: true
    },
    freezeBackgroundTabs: {
        type: OptionType.BOOLEAN,
        description: "Pause background browser tabs to save CPU. Tabs playing audio keep running.",
        default: true
    },
    discardAfterMinutes: {
        type: OptionType.SLIDER,
        description: "Unload background browser tabs after this many minutes, reloading them when you return. Tabs playing audio are never unloaded.",
        markers: [0, 15, 30, 60, 120],
        default: 30,
        stickToMarkers: true
    }
});

export interface WebviewElement extends HTMLElement {
    src: string;
    getURL(): string;
    getTitle(): string;
    isLoading(): boolean;
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
    loadURL(url: string): Promise<void>;
    isCurrentlyAudible(): boolean;
    getWebContentsId(): number;
    executeJavaScript(code: string): Promise<unknown>;
}

export interface ViewState {
    url: string;
    title: string;
    favicon: string | null;
    loading: boolean;
    audible: boolean;
}

const EMPTY_VIEW: ViewState = {
    url: "",
    title: "",
    favicon: null,
    loading: false,
    audible: false
};

const views = new Map<string, ViewState>();
const elements = new Map<string, WebviewElement>();
const viewListeners = new Set<() => void>();
let viewsVersion = 0;

function subscribeViews(listener: () => void) {
    viewListeners.add(listener);
    return () => void viewListeners.delete(listener);
}

function emitViews() {
    viewsVersion++;
    for (const listener of viewListeners) listener();
}

export function useViewsVersion() {
    return React.useSyncExternalStore(subscribeViews, () => viewsVersion);
}

export function getView(id: string) {
    return views.get(id) ?? EMPTY_VIEW;
}

export function updateView(id: string, patch: Partial<ViewState>) {
    views.set(id, { ...getView(id), ...patch });
    emitViews();
}

export function dropView(id: string) {
    if (views.delete(id)) emitViews();
}

export function refreshAudible(id: string) {
    const element = elements.get(id);
    if (!element) return;

    const audible = audibleOf(element);
    if (getView(id).audible === audible) return;

    updateView(id, { audible });
    pushTabs();
}

export function registerElement(id: string, element: WebviewElement | null) {
    if (element) {
        elements.set(id, element);
        lastActive.set(id, Date.now());
    } else {
        elements.delete(id);
        frozen.delete(id);
    }

    syncActiveGuest();
}

function syncActiveGuest() {
    const id = activeBrowserId();
    const element = id === null ? undefined : elements.get(id);

    Native.setActiveGuest(element ? contentsIdOf(element) : null);
}

export function getElement(id: string) {
    return elements.get(id);
}

function tabSnapshot() {
    const activeId = activeTabId();
    const tabs: unknown[] = [];

    for (const [id, element] of elements) {
        const contentsId = contentsIdOf(element);
        const url = element.getURL();
        if (contentsId === null || !url.startsWith("http")) continue;

        const active = id === activeId;
        tabs.push({
            id: contentsId, index: tabs.length, windowId: 0, url, title: element.getTitle(),
            active, highlighted: active, selected: active, audible: getView(id).audible,
            status: element.isLoading() ? "loading" : "complete",
            pinned: false, incognito: false, discarded: false, autoDiscardable: true, frozen: false, groupId: -1
        });
    }

    return tabs;
}

let knownTabs = new Map<string, number>();
let lastActiveContents: number | null = null;

let backgroundsReady = false;

export function areBackgroundsReady() {
    return backgroundsReady;
}

export function markBackgroundsReady() {
    if (backgroundsReady) return;

    backgroundsReady = true;
    emitViews();
}

export function seedTabs() {
    lastActiveContents = null;
    pushTabs();
}

export function pushTabs() {
    const tabs = tabSnapshot();
    Native.emitExtensionEvent("tabs", tabs);

    const present = new Map<string, number>();
    for (const [id, element] of elements) {
        const contentsId = contentsIdOf(element);
        if (contentsId !== null) present.set(id, contentsId);
    }

    const open = new Set(ChannelTabsStore.getTabs().map(tab => browserIdOf(tab)));

    for (const [id, contentsId] of knownTabs) {
        if (present.has(id) || open.has(id)) continue;
        Native.emitExtensionEvent("removed", contentsId);
    }
    knownTabs = present;

    const active = (tabs.find(tab => (tab as { active: boolean; }).active) as { id: number; } | undefined)?.id ?? null;
    if (active !== null && active !== lastActiveContents) {
        Native.emitExtensionEvent("activated", active);
    }
    lastActiveContents = active;
}

export function emitNavigation(element: WebviewElement, kind: string) {
    const id = contentsIdOf(element);
    if (id === null) return;

    const url = element.getURL();
    if (!url.startsWith("http")) return;

    const details = {
        tabId: id, url, frameId: 0, parentFrameId: -1, processId: 0,
        timeStamp: Date.now(), transitionType: "link", transitionQualifiers: [],
        frameType: "outermost_frame", documentLifecycle: "active"
    };

    Native.emitExtensionEvent("navigate", { kind, details });
}

export function emitTabUpdate(element: WebviewElement) {
    const id = contentsIdOf(element);
    if (id === null) return;

    const tab = { id, url: element.getURL(), title: element.getTitle(), status: "complete", active: true, windowId: 0, index: 0 };
    const payload = { id, changeInfo: { status: "complete", url: tab.url }, tab };

    pushTabs();
    Native.emitExtensionEvent("update", payload);
}

function elementForContents(contentsId: number) {
    for (const [id, element] of elements) {
        if (contentsIdOf(element) === contentsId) return { id, element };
    }

    return null;
}

export function handleTabsRequest(data: { __vcIab: string; tabId?: number; url?: string; tabIds?: number[]; }) {
    if (data.__vcIab === "tabs-update") {
        const target = data.tabId == null ? null : elementForContents(data.tabId);
        if (data.url) (target?.element ?? getElement(activeBrowserId() ?? ""))?.loadURL(data.url);
        return;
    }

    for (const contentsId of data.tabIds ?? []) {
        const target = elementForContents(contentsId);
        if (target) closeBrowserTab(target.id);
    }
}

function closeBrowserTab(browserId: string) {
    for (const tab of ChannelTabsStore.getTabs()) {
        if (browserIdOf(tab) !== browserId) continue;

        FluxDispatcher.dispatch({ type: "CHANNEL_TABS_CLOSE", tabId: tab.id });
        return;
    }
}

const discarded = new Set<string>();
const frozen = new Set<string>();
const lastActive = new Map<string, number>();
let sweepTimer: number | undefined;

export function isDiscarded(id: string) {
    return discarded.has(id);
}

function audibleOf(element: WebviewElement) {
    try {
        return element.isCurrentlyAudible();
    } catch {
        return false;
    }
}

function contentsIdOf(element: WebviewElement) {
    try {
        return element.getWebContentsId();
    } catch {
        return null;
    }
}

async function applyFrozen(id: string, element: WebviewElement, next: boolean) {
    if (frozen.has(id) === next) return;

    const contentsId = contentsIdOf(element);
    if (contentsId === null) return;

    if (!await Native.setFrozen(contentsId, next)) return;

    if (next) frozen.add(id);
    else frozen.delete(id);
}

function activeBrowserId() {
    return tabsUsable() ? browserIdOf(ChannelTabsStore.getActiveTab()) : null;
}

let lastActiveBrowserId: string | null = null;

function activeTabId() {
    const id = activeBrowserId();
    if (id !== null) lastActiveBrowserId = id;
    else if (lastActiveBrowserId !== null && !elements.has(lastActiveBrowserId)) lastActiveBrowserId = null;

    return id ?? lastActiveBrowserId;
}

function wakeActive() {
    const id = activeBrowserId();
    if (id === null) return;

    lastActive.set(id, Date.now());

    const element = elements.get(id);
    if (element) applyFrozen(id, element, false);

    if (discarded.delete(id)) emitViews();
}

function sweep() {
    const activeId = activeBrowserId();
    const now = Date.now();

    const discardAfter = settings.store.discardAfterMinutes * 60_000;

    for (const [id, element] of elements) {
        refreshAudible(id);

        const keepAwake = id === activeId || audibleOf(element);

        if (keepAwake) {
            lastActive.set(id, now);
            applyFrozen(id, element, false);
            continue;
        }

        applyFrozen(id, element, settings.store.freezeBackgroundTabs);

        const since = lastActive.get(id) ?? now;
        lastActive.set(id, since);

        if (discardAfter > 0 && now - since > discardAfter) {
            frozen.delete(id);
            lastActive.delete(id);
            discarded.add(id);
            emitViews();
        }
    }
}

let idCounter = 0;
let pending: { id: string; url: string; } | null = null;

function nextId() {
    return `${Date.now().toString(36)}-${idCounter++}`;
}

function decode(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

interface BrowserRoute {
    id: string;
    url: string | null;
}

export function parseRoute(tab: TabEntry | null | undefined): BrowserRoute | null {
    if (tab?.kind !== "route" || !tab.routePath?.startsWith(`${BROWSER_ROUTE}/`)) return null;

    const rest = tab.routePath.slice(BROWSER_ROUTE.length + 1);
    if (!rest) return null;

    const slash = rest.indexOf("/");
    if (slash === -1) return { id: rest, url: null };

    return { id: rest.slice(0, slash), url: decode(rest.slice(slash + 1)) };
}

function routeFor(id: string, url?: string | null) {
    return url ? `${BROWSER_ROUTE}/${id}/${encodeURIComponent(url)}` : `${BROWSER_ROUTE}/${id}`;
}

export function canOpenBrowserTab() {
    return tabsUsable();
}

function isDiscordLink(url: string) {
    try {
        const { hostname } = new URL(url);
        return /(^|\.)(discord\.com|discordapp\.com|discord\.gg|discord\.new)$/i.test(hostname);
    } catch {
        return false;
    }
}

export function shouldOpenInTab(href: string | undefined) {
    if (!settings.store.openLinksInTabs) return false;
    if (!href || !/^https?:\/\//i.test(href)) return false;

    return !isDiscordLink(href) && canOpenBrowserTab();
}

export function extensionIdFromUrl(url: string) {
    const match = /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/[^/]+\/([a-p]{32})/.exec(url);
    return match?.[1] ?? null;
}

export function browserIdOf(tab: TabEntry | null | undefined) {
    return parseRoute(tab)?.id ?? null;
}

function tabsUsable() {
    return ChannelTabsStore.isUserOptedIn() && ChannelTabsStore.getTabs().length > 0;
}

function collectIds() {
    const ids: string[] = [];

    for (const tab of ChannelTabsStore.getTabs()) {
        const id = browserIdOf(tab);
        if (id && !ids.includes(id)) ids.push(id);
    }

    return ids;
}

export function useBrowserIds() {
    const joined = useStateFromStores([ChannelTabsStore], () => (tabsUsable() ? collectIds().join(",") : ""));
    return joined ? joined.split(",") : [];
}

export function useActiveBrowserId() {
    return useStateFromStores([ChannelTabsStore], () =>
        tabsUsable() ? browserIdOf(ChannelTabsStore.getActiveTab()) : null);
}

export function useBrowserOpen() {
    return useActiveBrowserId() !== null;
}

export function urlForId(id: string) {
    let found: string | null = null;

    for (const tab of ChannelTabsStore.getTabs()) {
        for (const entry of tab.entries) {
            const parsed = parseRoute(entry);
            if (parsed?.id === id && parsed.url) found = parsed.url;
        }
    }

    return found;
}

function historyBrowserId(tab: Tab) {
    for (let i = tab.index; i >= 0; i--) {
        const id = browserIdOf(tab.entries[i]);
        if (id) return id;
    }
    return null;
}

function leaveBrowserTab(tab: Tab) {
    restoreDeadline = 0;

    for (let i = tab.index - 1; i >= 0; i--) {
        const previous = tab.entries[i];
        if (browserIdOf(previous) !== null) continue;

        if (previous.kind === "channel" && previous.channelId) {
            ChannelRouter.transitionToChannel(previous.channelId);
            return;
        }
        if (previous.kind === "route" && previous.routePath) {
            NavigationRouter.transitionTo(previous.routePath);
            return;
        }
    }

    NavigationRouter.transitionToGuild("@me");
}

export function setBrowserOpen(value: boolean) {
    if (!tabsUsable()) {
        showToast("Browser tabs need Discord's tabs enabled.", Toasts.Type.FAILURE);
        return;
    }

    const tab = ChannelTabsStore.getActiveTab();
    if (!tab || value === (browserIdOf(tab) !== null)) return;

    if (!value) {
        leaveBrowserTab(tab);
        return;
    }

    FluxDispatcher.dispatch({
        type: "CHANNEL_TABS_NAVIGATE_ROUTE",
        routePath: routeFor(historyBrowserId(tab) ?? nextId()),
        routeLabel: BROWSER_LABEL
    });
}

export function openBrowserTab(url?: string) {
    if (!tabsUsable()) {
        showToast("Browser tabs need Discord's tabs enabled.", Toasts.Type.FAILURE);
        return;
    }

    const id = nextId();
    pending = url ? { id, url } : null;

    FluxDispatcher.dispatch({
        type: "CHANNEL_TABS_OPEN",
        kind: "route",
        routePath: routeFor(id),
        routeLabel: BROWSER_LABEL,
        active: true
    });
}

export function takePendingUrl(id: string) {
    if (pending?.id !== id) return null;

    const { url } = pending;
    pending = null;
    return url;
}

export function syncRouteUrl(id: string, url: string) {
    if (!tabsUsable()) return;

    const parsed = parseRoute(ChannelTabsStore.getActiveTab());
    if (parsed?.id !== id || parsed.url === url) return;

    FluxDispatcher.dispatch({
        type: "CHANNEL_TABS_NAVIGATE_ROUTE",
        routePath: routeFor(id, url),
        routeLabel: BROWSER_LABEL
    });
}

export function keepBrowserTab(tab: TabEntry, delta?: number) {
    const parsed = parseRoute(tab);
    if (!parsed) return false;

    const element = getElement(parsed.id);
    if (!element) return true;

    applyFrozen(parsed.id, element, false);

    if (delta === -1 && element.canGoBack()) element.goBack();
    else if (delta === 1 && element.canGoForward()) element.goForward();
    else if (parsed.url && element.getURL() !== parsed.url) element.loadURL(parsed.url);

    return true;
}

const RESTORE_WINDOW = 10_000;

let restoreDeadline = 0;

function onTabsChanged() {
    pushTabs();
    wakeActive();
    syncActiveGuest();
    trackRestore();
}

function trackRestore() {
    if (Date.now() > restoreDeadline) return;

    const active = ChannelTabsStore.getActiveTab();
    if (!active || parseRoute(active)) return;

    const previous = parseRoute(active.entries[active.index - 1]);
    if (!previous) return;

    restoreDeadline = 0;

    FluxDispatcher.dispatch({
        type: "CHANNEL_TABS_NAVIGATE_ROUTE",
        routePath: routeFor(previous.id, previous.url),
        routeLabel: BROWSER_LABEL
    });
}

export function enableTabsExperiment() {
    if (!settings.store.enableTabs || ChannelTabsStore.isEnabled()) return;

    FluxDispatcher.dispatch({
        type: "APEX_EXPERIMENT_OVERRIDE_CREATE",
        experimentName: TABS_EXPERIMENT,
        variantId: 1
    });

    FluxDispatcher.dispatch({
        type: "CHANNEL_TABS_SET_ENABLED",
        enabled: true
    });
}

export function startSync() {
    enableTabsExperiment();

    restoreDeadline = Date.now() + RESTORE_WINDOW;
    trackRestore();

    ChannelTabsStore.addChangeListener(onTabsChanged);
    sweepTimer = window.setInterval(sweep, 15_000);
}

export function stopSync() {
    restoreDeadline = 0;
    ChannelTabsStore.removeChangeListener(onTabsChanged);

    if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
    }

    for (const [id, element] of elements) applyFrozen(id, element, false);
    discarded.clear();
}
