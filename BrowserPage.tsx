/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import { ResetIcon, RightArrow } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { PluginNative } from "@utils/types";
import { React, showToast, TextInput, Toasts, Tooltip, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent, ReactNode } from "react";

import {
    dropView,
    extensionIdFromUrl,
    getElement,
    getView,
    isDiscarded,
    PARTITION,
    refreshAudible,
    registerElement,
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
    onClick: () => void;
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
            loading: element.isLoading(),
            canGoBack: element.canGoBack(),
            canGoForward: element.canGoForward()
        });

        const onNavigate = () => {
            updateView(id, { favicon: null });
            sync();
        };

        const onFavicon = async (event: Event & { favicons?: string[]; }) => {
            const url = event.favicons?.[0];
            updateView(id, { favicon: url ? await Native.fetchFavicon(url) : null });
        };

        const onMedia = () => {
            refreshAudible(id);
            setTimeout(() => refreshAudible(id), 500);
        };

        element.addEventListener("media-started-playing", onMedia);
        element.addEventListener("media-paused", onMedia);
        element.addEventListener("dom-ready", sync);
        element.addEventListener("did-navigate", onNavigate);
        element.addEventListener("did-navigate-in-page", sync);
        element.addEventListener("did-start-loading", sync);
        element.addEventListener("did-stop-loading", sync);
        element.addEventListener("page-title-updated", sync);
        element.addEventListener("page-favicon-updated", onFavicon as EventListener);

        return () => {
            registerElement(id, null);
            element.removeEventListener("media-started-playing", onMedia);
            element.removeEventListener("media-paused", onMedia);
            element.removeEventListener("dom-ready", sync);
            element.removeEventListener("did-navigate", onNavigate);
            element.removeEventListener("did-navigate-in-page", sync);
            element.removeEventListener("did-start-loading", sync);
            element.removeEventListener("did-stop-loading", sync);
            element.removeEventListener("page-title-updated", sync);
            element.removeEventListener("page-favicon-updated", onFavicon as EventListener);
            dropView(id);
        };
    }, [id]);

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

        if (result.ok) showToast(`Installed ${result.name}.`, Toasts.Type.SUCCESS);
        else showToast(result.error ?? "Could not install that extension.", Toasts.Type.FAILURE);
    }

    return (
        <div className={cl("bar")} onKeyDown={handleKeyDown}>
            <IconButton label="Back" disabled={!view.canGoBack} onClick={() => getElement(id)?.goBack()}>
                <RightArrow className={cl("flip")} width={16} height={16} />
            </IconButton>
            <IconButton label="Forward" disabled={!view.canGoForward} onClick={() => getElement(id)?.goForward()}>
                <RightArrow width={16} height={16} />
            </IconButton>
            <IconButton label="Reload" onClick={() => getElement(id)?.reload()}>
                <ResetIcon className={classes(view.loading && cl("spin"))} width={16} height={16} />
            </IconButton>
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
            <div className={cl("stage")}>
                {ids.filter(id => !isDiscarded(id)).map(id => (
                    <WebviewFrame key={id} id={id} active={id === activeId} />
                ))}
            </div>
        </div>
    );
}
