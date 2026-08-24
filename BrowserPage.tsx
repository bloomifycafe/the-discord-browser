/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import { ResetIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { PluginNative } from "@utils/types";
import { ContextMenuApi, Menu, React, SettingsRouter, showToast, TextInput, Toasts, Tooltip, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

import {
    areBackgroundsReady,
    dropView,
    emitNavigation,
    emitTabUpdate,
    extensionIdFromUrl,
    getElement,
    getView,
    handleTabsRequest,
    isDiscarded,
    markBackgroundsReady,
    openBrowserTab,
    PARTITION,
    refreshAudible,
    registerElement,
    seedTabs,
    settings,
    syncRouteUrl,
    takePendingUrl,
    updateView,
    urlForId,
    useViewsVersion,
    WebviewElement
} from "./state";

const cl = classNameFactory("vc-iab-");

const Native = VencordNative.pluginHelpers.InAppBrowser as PluginNative<typeof import("./native")>;

interface IconButtonProps {
    label: string;
    disabled?: boolean;
    onClick: (event: MouseEvent) => void;
    children: ReactNode;
}

function IconButton({ label, disabled, onClick, children }: IconButtonProps) {
    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <Button
                    {...tooltipProps}
                    variant="secondary"
                    size="iconOnly"
                    aria-label={label}
                    disabled={disabled}
                    onClick={onClick}
                >
                    {children}
                </Button>
            )}
        </Tooltip>
    );
}

function PuzzleIcon() {
    return (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M10 3a2.5 2.5 0 0 1 5 0v1h2.5A1.5 1.5 0 0 1 19 5.5V8h1a2.5 2.5 0 0 1 0 5h-1v2.5a1.5 1.5 0 0 1-1.5 1.5H15v1a2.5 2.5 0 0 1-5 0v-1H7.5A1.5 1.5 0 0 1 6 15.5V13H5a2.5 2.5 0 0 1 0-5h1V5.5A1.5 1.5 0 0 1 7.5 4H10V3Z" />
        </svg>
    );
}

type Extension = Awaited<ReturnType<typeof Native.getExtensions>>["extensions"][number];

function BackgroundHost({ url, onReady: ready }: { url: string; onReady: () => void; }) {
    const ref = useRef<WebviewElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const onHostMessage = (event: Event & { channel?: string; args?: unknown[]; }) => {
            if (event.channel === "vc-iab-open-tab") openBrowserTab(String(event.args?.[0] ?? ""));
            if (event.channel === "vc-iab-tabs") handleTabsRequest(event.args?.[0] as never);
        };

        const onReady = () => { seedTabs(); ready(); };

        element.addEventListener("ipc-message", onHostMessage as EventListener);
        element.addEventListener("dom-ready", onReady);

        return () => {
            element.removeEventListener("ipc-message", onHostMessage as EventListener);
            element.removeEventListener("dom-ready", onReady);
        };
    }, []);

    return React.createElement("webview", {
        ref,
        src: url,
        partition: PARTITION,
        style: { width: "100%", height: "100%", display: "flex" }
    });
}

function BackgroundHosts() {
    const [pages, setPages] = useState<Array<{ id: string; name: string; url: string; }>>([]);

    const ready = useRef(new Set<string>());
    const expected = useRef(0);

    useEffect(() => {
        Native.getBackgroundPages().then(result => {
            expected.current = result.length;
            setPages(result);
            if (result.length === 0) markBackgroundsReady();
        });

        const fallback = setTimeout(markBackgroundsReady, 10_000);
        return () => clearTimeout(fallback);
    }, []);

    return (
        <div className={cl("backgrounds")} aria-hidden>
            {pages.map(page => (
                <BackgroundHost
                    key={page.id}
                    url={page.url}
                    onReady={() => {
                        ready.current.add(page.id);
                        if (expected.current === 0 || ready.current.size < expected.current) return;

                        setTimeout(markBackgroundsReady, 1500);
                    }}
                />
            ))}
        </div>
    );
}

const POPUP_MAX = { width: 800, height: 720 };

function ExtensionPopup({ url, onClose }: { url: string; onClose: () => void; }) {
    const ref = useRef<WebviewElement>(null);
    const [size, setSize] = useState({ width: 360, height: 480 });

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const measure = async () => {
            const measured = await element.executeJavaScript(`(() => {
                const root = document.documentElement;
                const blocks = Array.from(document.body.children)
                    .map(child => [child, child.getBoundingClientRect()])
                    .filter(entry => entry[1].width > 0 && entry[1].height > 0);

                const widest = blocks.length === 0 ? 0
                    : Math.max(...blocks.map(entry => Math.max(entry[0].scrollWidth, entry[1].width)));
                const tallest = blocks.length === 0 ? 0
                    : Math.max(...blocks.map(entry => Math.max(entry[0].scrollHeight, entry[1].height)));

                return [
                    Math.max(widest, root.scrollWidth > window.innerWidth ? root.scrollWidth : 0),
                    Math.max(tallest, root.scrollHeight > window.innerHeight ? root.scrollHeight : 0)
                ];
            })()`).catch(() => null) as [number, number] | null;

            if (!measured) return;

            const next = {
                width: Math.min(Math.max(measured[0], 200), POPUP_MAX.width),
                height: Math.min(Math.max(measured[1], 120), POPUP_MAX.height)
            };

            setSize(current => current.width === next.width && current.height === next.height ? current : next);
        };

        const onReady = () => {
            seedTabs();
            measure();
        };

        const onOpenTab = (event: Event & { channel?: string; args?: unknown[]; }) => {
            if (event.channel === "vc-iab-open-tab") openBrowserTab(String(event.args?.[0] ?? ""));
        };

        const timer = setInterval(measure, 300);
        element.addEventListener("dom-ready", onReady);
        element.addEventListener("ipc-message", onOpenTab as EventListener);

        return () => {
            clearInterval(timer);
            element.removeEventListener("dom-ready", onReady);
            element.removeEventListener("ipc-message", onOpenTab as EventListener);
        };
    }, [url]);

    useEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);

        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <>
            <div className={cl("popup-scrim")} onClick={onClose} />
            <div className={cl("popup")} style={size}>
                {React.createElement("webview", {
                    ref,
                    src: url,
                    partition: PARTITION,
                    style: { width: "100%", height: "100%", display: "flex" }
                })}
            </div>
        </>
    );
}

function ExtensionsMenu({ extensions, onPopup }: { extensions: Extension[]; onPopup: (url: string) => void; }) {
    const usable = extensions.filter(extension => extension.loaded);

    return (
        <Menu.Menu navId="vc-iab-extensions" onClose={ContextMenuApi.closeContextMenu} aria-label="Extensions">
            <Menu.MenuGroup>
                {usable.length === 0 && (
                    <Menu.MenuItem id="vc-iab-ext-none" label="No extensions installed" disabled action={() => { }} />
                )}
                {usable.map(extension => (
                    <Menu.MenuItem
                        key={extension.storeId}
                        id={`vc-iab-ext-${extension.storeId}`}
                        label={extension.name}
                        disabled={!extension.popupUrl && !extension.optionsUrl}
                        action={() => extension.popupUrl
                            ? onPopup(extension.popupUrl)
                            : openBrowserTab(extension.optionsUrl ?? undefined)}
                    />
                ))}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-iab-ext-manage"
                label="Manage extensions"
                action={() => SettingsRouter.openUserSettings("vc_in_app_browser_extensions_panel")}
            />
        </Menu.Menu>
    );
}

function WebviewFrame({ id, active }: { id: string; active: boolean; }) {
    const ref = useRef<WebviewElement>(null);
    const [initialSrc] = useState(() => urlForId(id) ?? takePendingUrl(id) ?? settings.store.homepage);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        registerElement(id, element);

        const sync = () => updateView(id, {
            url: element.getURL(),
            title: element.getTitle(),
            loading: element.isLoading()
        });

        const onNavigate = () => {
            updateView(id, { favicon: null });
            sync();
            emitNavigation(element, "onCommitted");
        };

        const onStartNavigation = () => emitNavigation(element, "onBeforeNavigate");
        const onInPage = () => { sync(); emitNavigation(element, "onHistoryStateUpdated"); };
        const onDomReady = () => { sync(); emitNavigation(element, "onDOMContentLoaded"); };

        const onFavicon = async (event: Event & { favicons?: string[]; }) => {
            const url = event.favicons?.[0];
            updateView(id, { favicon: url ? await Native.fetchFavicon(url) : null });
        };

        const onStopLoading = () => {
            sync();
            emitNavigation(element, "onCompleted");
            emitTabUpdate(element);
        };

        const onOpenTab = (event: Event & { channel?: string; args?: unknown[]; }) => {
            if (event.channel === "vc-iab-open-tab") openBrowserTab(String(event.args?.[0] ?? ""));
            if (event.channel === "vc-iab-tabs") handleTabsRequest(event.args?.[0] as never);
        };

        const onMedia = () => {
            refreshAudible(id);
            setTimeout(() => refreshAudible(id), 500);
        };

        element.addEventListener("ipc-message", onOpenTab as EventListener);
        element.addEventListener("media-started-playing", onMedia);
        element.addEventListener("media-paused", onMedia);
        element.addEventListener("dom-ready", onDomReady);
        element.addEventListener("did-navigate", onNavigate);
        element.addEventListener("did-navigate-in-page", onInPage);
        element.addEventListener("did-start-loading", sync);
        element.addEventListener("did-start-navigation", onStartNavigation);
        element.addEventListener("did-stop-loading", onStopLoading);
        element.addEventListener("page-title-updated", sync);
        element.addEventListener("page-favicon-updated", onFavicon as EventListener);

        return () => {
            registerElement(id, null);
            element.removeEventListener("ipc-message", onOpenTab as EventListener);
            element.removeEventListener("media-started-playing", onMedia);
            element.removeEventListener("media-paused", onMedia);
            element.removeEventListener("dom-ready", onDomReady);
            element.removeEventListener("did-navigate", onNavigate);
            element.removeEventListener("did-navigate-in-page", onInPage);
            element.removeEventListener("did-start-loading", sync);
            element.removeEventListener("did-start-navigation", onStartNavigation);
            element.removeEventListener("did-stop-loading", onStopLoading);
            element.removeEventListener("page-title-updated", sync);
            element.removeEventListener("page-favicon-updated", onFavicon as EventListener);
            dropView(id);
        };
    }, [id]);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        if (active) element.focus();
    }, [active]);

    return (
        <div className={cl("view", { active })}>
            {React.createElement("webview", {
                ref,
                src: initialSrc,
                partition: PARTITION,
                style: { width: "100%", height: "100%", display: "flex" }
            })}
        </div>
    );
}

function BrowserChrome({ id }: { id: string; }) {
    useViewsVersion();

    const view = getView(id);
    const [address, setAddress] = useState(view.url);
    const [extensions, setExtensions] = useState<Extension[]>([]);
    const [popup, setPopup] = useState<string | null>(null);

    const refreshExtensions = () => Native.getExtensions().then(result => setExtensions(result.extensions));

    useEffect(() => { refreshExtensions(); }, []);

    useEffect(() => setAddress(view.url), [id, view.url]);

    useEffect(() => {
        if (view.url) syncRouteUrl(id, view.url);
    }, [id, view.url]);

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;

        event.preventDefault();
        getElement(id)?.loadURL(normalize(address));
    }

    const extensionId = extensionIdFromUrl(view.url);

    async function install() {
        if (!extensionId) return;

        showToast("Installing extension…", Toasts.Type.MESSAGE);
        const result = await Native.installExtension(extensionId);

        if (result.ok) {
            showToast(`Installed ${result.name}.`, Toasts.Type.SUCCESS);
            refreshExtensions();
        }
        else showToast(result.error ?? "Could not install that extension.", Toasts.Type.FAILURE);
    }

    return (
        <div className={cl("bar")} onKeyDown={handleKeyDown}>
            <IconButton label="Reload" onClick={() => getElement(id)?.reload()}>
                <ResetIcon className={classes(view.loading && cl("spin"))} width={16} height={16} />
            </IconButton>
            <IconButton
                label="Extensions"
                onClick={event => {
                    ContextMenuApi.openContextMenu(event, () => (
                        <ExtensionsMenu extensions={extensions} onPopup={setPopup} />
                    ));
                    refreshExtensions();
                }}
            >
                <PuzzleIcon />
            </IconButton>
            {popup && <ExtensionPopup url={popup} onClose={() => setPopup(null)} />}
            {extensionId && (
                <Button variant="primary" size="small" onClick={install}>
                    Install extension
                </Button>
            )}
            <div className={cl("address")}>
                <TextInput
                    value={address}
                    onChange={setAddress}
                    placeholder="Search or enter address"
                    spellCheck={false}
                />
            </div>
        </div>
    );
}

function normalize(input: string) {
    const text = input.trim();
    if (!text) return settings.store.homepage;

    if (/^https?:\/\//i.test(text)) return text;
    if (/^[^\s/?#]+\.[^\s/?#]{2,}/.test(text)) return `https://${text}`;

    return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

export function BrowserFrame({ ids, activeId }: { ids: string[]; activeId: string | null; }) {
    useViewsVersion();

    const frame = useRef<HTMLDivElement>(null);
    const parked = useRef<{ width: number; height: number; }>(null);
    const lastActive = useRef<string>(null);

    if (activeId !== null) lastActive.current = activeId;
    const chromeId = activeId ?? lastActive.current;

    useLayoutEffect(() => {
        if (activeId === null || !frame.current) return;

        const { width, height } = frame.current.getBoundingClientRect();
        if (width && height) parked.current = { width, height };
    });

    return (
        <div
            ref={frame}
            className={cl("frame", { active: activeId !== null })}
            style={activeId === null ? parked.current ?? undefined : undefined}
        >
            {chromeId !== null && <BrowserChrome id={chromeId} />}
            <BackgroundHosts />
            <div className={cl("stage")}>
                {areBackgroundsReady() && ids.filter(id => !isDiscarded(id)).map(id => (
                    <WebviewFrame key={id} id={id} active={id === activeId} />
                ))}
            </div>
        </div>
    );
}
