/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { PluginNative } from "@utils/types";
import { showToast, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { extensionIdFromUrl, openBrowserTab } from "./state";

const cl = classNameFactory("vc-iab-");

const Native = VencordNative.pluginHelpers.InAppBrowser as PluginNative<typeof import("./native")>;

type Listing = Awaited<ReturnType<typeof Native.getExtensions>>;

export function ExtensionsPage() {
    const [listing, setListing] = useState<Listing | null>(null);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);

    const refresh = () => Native.getExtensions().then(setListing);

    useEffect(() => { refresh(); }, []);

    async function install() {
        const id = extensionIdFromUrl(input) ?? input.trim();
        setBusy(true);

        const result = await Native.installExtension(id);
        setBusy(false);

        if (result.ok) {
            showToast(`Installed ${result.name}.`, Toasts.Type.SUCCESS);
            setInput("");
            refresh();
        } else {
            showToast(result.error ?? "Could not install that extension.", Toasts.Type.FAILURE);
        }
    }

    async function remove(storeId: string, name: string) {
        const result = await Native.removeExtension(storeId);

        if (result.ok) {
            showToast(`Removed ${name}.`, Toasts.Type.SUCCESS);
            refresh();
        } else {
            showToast(result.error ?? "Could not remove that extension.", Toasts.Type.FAILURE);
        }
    }

    return (
        <div>
            <Heading tag="h2">Browser Extensions</Heading>
            <Paragraph className={Margins.top8}>
                Extensions for the in-app browser. Paste a Chrome Web Store link or an extension id to install one,
                or drop an unpacked extension into the folder below. Electron supports a subset of the extension
                APIs, so content scripts generally work while some background and tabs APIs may not.
            </Paragraph>

            <div className={cl("install-row", [Margins.top16])}>
                <div className={cl("install-input")}>
                    <TextInput
                        value={input}
                        onChange={setInput}
                        placeholder="Chrome Web Store link or extension id"
                        spellCheck={false}
                    />
                </div>
                <Button disabled={busy || input.trim() === ""} onClick={install}>
                    {busy ? "Installing…" : "Install"}
                </Button>
                <Button variant="secondary" onClick={() => Native.openExtensionsFolder()}>
                    Open folder
                </Button>
            </div>

            {listing?.extensions.length === 0 && (
                <Paragraph className={Margins.top16}>No extensions installed yet.</Paragraph>
            )}

            {listing?.extensions.map(extension => (
                <div key={extension.storeId} className={cl("extension", [Margins.top8])}>
                    <div className={cl("extension-info")}>
                        <Heading tag="h5">{extension.name} {extension.version}</Heading>
                        <Paragraph className={cl("extension-meta")}>
                            {extension.error
                                ? `Failed to load: ${extension.error}`
                                : extension.loaded
                                    ? extension.storeId
                                    : `${extension.storeId} — restart to load`}
                        </Paragraph>
                    </div>
                    {extension.optionsUrl && (
                        <Button variant="secondary" onClick={() => openBrowserTab(extension.optionsUrl ?? undefined)}>
                            Options
                        </Button>
                    )}
                    <Button variant="dangerPrimary" onClick={() => remove(extension.storeId, extension.name)}>
                        Remove
                    </Button>
                </div>
            ))}

            <Paragraph className={Margins.top16}>
                Newly installed extensions load right away. Removing one unloads it immediately, and extensions
                added to the folder by hand need a restart.
            </Paragraph>
        </div>
    );
}
