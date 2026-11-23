/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import ErrorBoundary from "@components/ErrorBoundary";
import { WebsiteIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { classNameFactory } from "@utils/css";
import { parseUrl, removeFromArray } from "@utils/misc";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ContextMenuApi, FluxDispatcher, Menu } from "@webpack/common";
import type { ComponentProps, MouseEvent } from "react";

import { BrowserFrame } from "./BrowserPage";
import { ExtensionsPage } from "./ExtensionsPage";
import {
    browserIdOf,
    enableTabsExperiment,
    findBrowserTabs,
    getView,
    keepBrowserTab,
    openBrowserTab,
    settings,
    shouldOpenInTab,
    startSync,
    stopSync,
    useActiveBrowserId,
    useBrowserIds,
    useBrowserOpen,
    useViewsVersion
} from "./state";

const cl = classNameFactory("vc-iab-");

function SpeakerIcon() {
    return (
        <svg className={cl("audio")} width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3Z" />
            <path d="M15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
        </svg>
    );
}

const SETTINGS_KEYS: Array<"hideServerList"> = ["hideServerList"];

function PageHost({ children, ...rest }: ComponentProps<"div">) {
    const activeId = useActiveBrowserId();
    const ids = useBrowserIds();

    return (
        <div {...rest}>
            {activeId === null && children}
            <BrowserFrame ids={ids} activeId={activeId} />
        </div>
    );
}

const QuickSwitcherRow = findComponentByCodeLazy("navigationRecord:", ".PLAYGROUND:");

const TAB_RESULT = "vc-iab-tab";

type BrowserTab = ReturnType<typeof findBrowserTabs>[number];

interface TabResult {
    type: string;
    record: BrowserTab;
}

interface TabResultRowProps {
    tab: BrowserTab;
    rowProps: Record<string, unknown>;
}

function selectTab(tab: BrowserTab) {
    FluxDispatcher.dispatch({ type: "CHANNEL_TABS_SET_ACTIVE", tabId: tab.id });
    FluxDispatcher.dispatch({ type: "QUICKSWITCHER_HIDE" });
}

const TabResultRow = ErrorBoundary.wrap(({ tab, rowProps }: TabResultRowProps) => (
    <QuickSwitcherRow
        {...rowProps}
        navigationRecord={{
            type: "PLAYGROUND",
            label: tab.title,
            IconComponent: () => tab.favicon
                ? <img className={cl("favicon")} src={tab.favicon} alt="" aria-hidden />
                : <WebsiteIcon width={16} height={16} />
        }}
        onClick={() => selectTab(tab)}
    >
        {parseUrl(tab.url)?.hostname}
    </QuickSwitcherRow>
), { noop: true });

export default definePlugin({
    name: "InAppBrowser",
    description: "Browse the web in Discord's own tabs, each with its own page.",
    authors: [{ name: "mistine", id: 351566574307508225n }],
    settings,

    patches: [
        {
            find: '"AppView"',
            replacement: [
                {
                    match: /(?<=\(0,\i\.jsx\)\()"div"(?=,\{className:\i\.\i,"data-collapsed":!1)/,
                    replace: "$self.PageHost"
                },
                {
                    match: /hideChannelList:(\i\|\|\i\|\|\i)(?=,)/,
                    replace: "hideChannelList:$self.useBrowserOpen()||$1"
                },
                {
                    match: /hideSidebar:(!\i)(?=\})/,
                    replace: "hideSidebar:$self.useHideServerList()||$1"
                }
            ]
        },
        {
            find: "trackAnnouncementMessageLinkClicked({",
            replacement: {
                match: /(?<=function \i\(\i,\i\)\{)(?=(?:(?!function ).){0,300}trusted:)/,
                replace: "if($self.handleLink(...arguments))return;"
            }
        },
        {
            find: 'type:"CHANNEL_TABS_MOVE"',
            replacement: [
                {
                    match: /(?<="route"===(\i)\.kind\?)\(0,\i\.pX\)\(\i\.routePath,/,
                    replace: "$self.keepBrowserTab($1)||$&"
                },
                {
                    match: /(?<=\.index\+(\i);.{0,150}?"route"===(\i)\.kind\)\i=\(\)=>)\(0,\i\.pX\)\(\i\.routePath\)/,
                    replace: "$self.keepBrowserTab($2,$1)||$&"
                }
            ]
        },
        {
            find: "PlusLargeIcon,onClick:",
            replacement: [
                {
                    match: /(?<=icon:\i\.PlusLargeIcon,onClick:)\(\)=>\(0,\i\.\i\)\("new_tab_button"\)/,
                    replace: "vcIabEvent=>$self.openNewTabMenu(vcIabEvent,$&)"
                },
                {
                    match: /(?<=let )(?=\i="route"===(\i)\.kind\?)/,
                    replace: "vcIabLabel=$self.useTabLabel($1),"
                },
                {
                    match: /(?<="route"===\i\.kind\?)\i\.routeLabel(?=:)/,
                    replace: "vcIabLabel??$&"
                },
                {
                    match: /(\i)=null;(?=if\("route"===(\i)\.kind\)\{let \i=\i\[\i\.routePath\])/,
                    replace: "$1=$self.useTabIcon($2);"
                }
            ]
        },
        {
            find: '"QuickSwitcherStore"',
            replacement: {
                match: /,(\i)\}\(\):(\i)(?=,\i\)\)\{\i=\i;var \i=\i,\i=(\i);switch\((\i)\))/,
                replace: ',$self.withTabResults($1,"",$4)}():$self.withTabResults($2,$3,$4)'
            }
        },
        {
            find: "#{intl::QUICKSWITCHER_PLACEHOLDER}",
            replacement: [
                {
                    match: /(?<=renderRow=\i=>\{let\{row:(\i)\}=\i,(\i)=this\.props\.results\[\i\],\{selectedIndex:(\i)\}=this\.props.{0,120}?;)(?=switch\(\i\.type\))/,
                    replace: `if($2.type==="${TAB_RESULT}")return $self.renderTabRow($2,{id:this.getRowId($1),focused:$1===$3,onMouseEnter:()=>this.focusResult($2),onFocus:this.focusNode});`
                },
                {
                    match: /(?<=onPick:\((\i),\i\)=>\{)/,
                    replace: "if($self.selectTabResult($1))return;"
                }
            ]
        }
    ],

    keepBrowserTab,

    flux: {
        CONNECTION_OPEN: enableTabsExperiment
    },

    handleLink(data: { href?: string; }, event?: MouseEvent) {
        if (!shouldOpenInTab(data?.href)) return false;

        event?.preventDefault();
        openBrowserTab(data.href);
        return true;
    },

    useBrowserOpen,

    useHideServerList() {
        const { hideServerList } = settings.use(SETTINGS_KEYS);
        return useBrowserOpen() && hideServerList;
    },

    useTabLabel(tab: Parameters<typeof browserIdOf>[0]) {
        useViewsVersion();

        const id = browserIdOf(tab);
        if (id === null) return null;

        return getView(id).title || "Browser";
    },

    useTabIcon(tab: Parameters<typeof browserIdOf>[0]) {
        useViewsVersion();

        const id = browserIdOf(tab);
        if (id === null) return null;

        const { favicon, audible } = getView(id);
        if (audible) return <SpeakerIcon />;
        if (!favicon) return <WebsiteIcon width={16} height={16} />;

        return <img className={cl("favicon")} src={favicon} alt="" aria-hidden />;
    },

    openNewTabMenu(event: MouseEvent, createDiscordTab: () => void) {
        if (settings.store.newTabOpensBrowser) {
            openBrowserTab();
            return;
        }

        ContextMenuApi.openContextMenu(event, () => (
            <Menu.Menu
                navId="vc-iab-new-tab"
                onClose={ContextMenuApi.closeContextMenu}
                aria-label="New tab"
            >
                <Menu.MenuItem id="vc-iab-discord-tab" label="Discord tab" action={createDiscordTab} />
                <Menu.MenuItem id="vc-iab-browser-tab" label="Browser tab" action={() => openBrowserTab()} />
            </Menu.Menu>
        ));
    },

    withTabResults(results: unknown[], query: string, mode: string | null) {
        if (mode != null) return results;

        const tabs = findBrowserTabs(query);
        if (tabs.length === 0) return results;

        return [
            ...results,
            { type: "HEADER", record: { id: "vc-iab-tabs", text: "Browser tabs" }, score: 0 },
            ...tabs.map(tab => ({ type: TAB_RESULT, record: tab, score: 0 }))
        ];
    },

    renderTabRow(result: TabResult, rowProps: Record<string, unknown>) {
        return <TabResultRow key={`${TAB_RESULT}-${result.record.id}`} tab={result.record} rowProps={rowProps} />;
    },

    selectTabResult(result: TabResult) {
        if (result.type !== TAB_RESULT) return false;

        selectTab(result.record);
        return true;
    },

    PageHost: ErrorBoundary.wrap(PageHost, {
        fallback: ({ wrappedProps }) => <div {...wrappedProps} />
    }),

    commands: [
        {
            name: "browse",
            description: "Open a page in a new browser tab.",
            options: [
                {
                    name: "url",
                    description: "Address or search terms",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute(args) {
                openBrowserTab(findOption(args, "url", settings.store.homepage));
            }
        }
    ],

    start() {
        startSync();

        SettingsPlugin.customEntries.push({
            key: "vc_in_app_browser_extensions",
            title: "Browser Extensions",
            Component: ExtensionsPage,
            Icon: WebsiteIcon
        });
    },

    stop() {
        stopSync();
        removeFromArray(SettingsPlugin.customEntries, entry => entry.key === "vc_in_app_browser_extensions");
    }
});
