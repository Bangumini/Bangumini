import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useIsFetching } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  SearchIcon,
  CalendarIcon,
  BookmarkIcon,
  SettingsIcon,
  SidebarIcon,
  StarIcon,
} from "./icons";
import { MOD } from "../api/shortcut";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import CustomSelect from "./CustomSelect";
import FetchIndicator from "./FetchIndicator";
import SyncQueueDock from "./SyncQueueDock";

const TABS = [
  { path: "/collections", label: "收藏", key: "1", Icon: BookmarkIcon },
  { path: "/calendar", label: "日历", key: "2", Icon: CalendarIcon },
  { path: "/next-season", label: "下季度", key: "5", Icon: StarIcon },
  { path: "/search", label: "搜索", key: "3", Icon: SearchIcon },
  { path: "/settings", label: "设置", key: "4", Icon: SettingsIcon },
] as const;

const COLLECTION_TYPES = [
  { value: "3", label: "在看" },
  { value: "1", label: "想看" },
  { value: "2", label: "看过" },
  { value: "4", label: "搁置" },
  { value: "5", label: "抛弃" },
];

const SUBJECT_TYPES = [
  { value: "", label: "全部" },
  { value: "2", label: "动画" },
  { value: "1", label: "书籍" },
  { value: "3", label: "音乐" },
  { value: "4", label: "游戏" },
  { value: "6", label: "三次元" },
];

const DEFAULT_SEARCH_TYPE = "2";

const NEXT_SEASON_WEEKDAYS = [
  { value: "", label: "全部" },
  { value: "0", label: "周日" },
  { value: "1", label: "周一" },
  { value: "2", label: "周二" },
  { value: "3", label: "周三" },
  { value: "4", label: "周四" },
  { value: "5", label: "周五" },
  { value: "6", label: "周六" },
  { value: "tba", label: "未定" },
  { value: "nontv", label: "非TV" },
];

const CALENDAR_WEEKDAYS = [
  { value: "", label: "全部" },
  { value: "1", label: "周一" },
  { value: "2", label: "周二" },
  { value: "3", label: "周三" },
  { value: "4", label: "周四" },
  { value: "5", label: "周五" },
  { value: "6", label: "周六" },
  { value: "7", label: "周日" },
];

const SIDEBAR_KEY = "bangumini_sidebar_collapsed";

type FilterPaletteKind = "search" | "collections" | "calendar" | "next-season";

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-fg-tertiary">
      <kbd className="inline-flex min-w-5 h-5 items-center justify-center px-1 rounded bg-elevated border border-line text-[11px] font-medium text-fg-secondary">
        {k}
      </kbd>
      <span className="text-[12px]">{label}</span>
    </span>
  );
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === "1",
  );
  const [filterPaletteOpen, setFilterPaletteOpen] = useState(false);
  const [filterPaletteIndex, setFilterPaletteIndex] = useState(0);
  const [filterPaletteKind, setFilterPaletteKind] = useState<FilterPaletteKind>("search");

  const isSearchPage = location.pathname === "/search";
  const isCollections = location.pathname === "/collections";
  const isCalendar = location.pathname === "/calendar";
  const isNextSeason = location.pathname === "/next-season";
  const isFetching = useIsFetching() > 0;
  const currentTab = TABS.findIndex((t) => t.path === location.pathname);
  const currentTabRef = useRef(currentTab);

  useEffect(() => {
    currentTabRef.current = currentTab;
  }, [currentTab]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  function getPaletteConfig(kind: FilterPaletteKind) {
    if (kind === "search") {
      return {
        options: SUBJECT_TYPES,
        currentValue: searchParams.has("stype")
          ? searchParams.get("stype") ?? ""
          : DEFAULT_SEARCH_TYPE,
        title: "条目类型",
      };
    }
    if (kind === "collections") {
      return {
        options: COLLECTION_TYPES,
        currentValue: searchParams.get("type") ?? "3",
        title: "收藏状态",
      };
    }
    if (kind === "calendar") {
      return {
        options: CALENDAR_WEEKDAYS,
        currentValue: searchParams.get("weekday") ?? "",
        title: "星期筛选",
      };
    }
    return {
      options: NEXT_SEASON_WEEKDAYS,
      currentValue: searchParams.get("weekday") ?? "",
      title: "星期筛选",
    };
  }

  function applyPaletteValue(kind: FilterPaletteKind, nextValue: string) {
    const params = new URLSearchParams(searchParams);

    if (kind === "search") {
      params.set("stype", nextValue);
    } else if (kind === "collections") {
      params.set("type", nextValue);
      params.delete("filter");
    } else {
      if (nextValue) params.set("weekday", nextValue);
      else params.delete("weekday");
      params.delete("filter");
    }

    setSearchParams(params, { replace: true });
  }

  function openFilterPalette(kind: FilterPaletteKind) {
    const { options, currentValue } = getPaletteConfig(kind);
    const idx = options.findIndex((o) => o.value === currentValue);
    setFilterPaletteKind(kind);
    setFilterPaletteIndex(idx >= 0 ? idx : 0);
    setFilterPaletteOpen(true);
  }

  function closeFilterPalette() {
    setFilterPaletteOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const handleHeaderMouseDown = async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (["BUTTON", "INPUT", "SELECT", "A"].includes(target.tagName)) return;
    e.preventDefault();
    try {
      await invoke("set_dragging", { dragging: true });
      await getCurrentWindow().startDragging();
    } finally {
      await invoke("set_dragging", { dragging: false });
    }
  };

  useKeyboardShortcuts([
    {
      key: "Escape",
      mod: false,
      alt: false,
      handler: ({ target, isTextInput }) => {
        if (filterPaletteOpen) {
          closeFilterPalette();
        } else if (isTextInput && target instanceof HTMLInputElement && target.value) {
          (target as HTMLInputElement).value = "";
          const event = new Event("input", { bubbles: true });
          target.dispatchEvent(event);
        } else {
          import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
            getCurrentWindow().hide();
          });
        }
      },
    },
    {
      key: "Tab",
      mod: false,
      alt: false,
      handler: () => {
        setCollapsed((v) => !v);
      },
    },
    {
      key: "p",
      mod: true,
      handler: () => {
        if (filterPaletteOpen) {
          closeFilterPalette();
          return;
        }
        if (isSearchPage) openFilterPalette("search");
        else if (isCollections) openFilterPalette("collections");
        else if (isCalendar) openFilterPalette("calendar");
        else if (isNextSeason) openFilterPalette("next-season");
      },
    },
    {
      key: "ArrowDown",
      when: () => filterPaletteOpen,
      stopPropagation: true,
      handler: () => {
        const { options } = getPaletteConfig(filterPaletteKind);
        setFilterPaletteIndex((i) => Math.min(options.length - 1, i + 1));
      },
    },
    {
      key: "ArrowUp",
      when: () => filterPaletteOpen,
      stopPropagation: true,
      handler: () => {
        setFilterPaletteIndex((i) => Math.max(0, i - 1));
      },
    },
    {
      key: "Enter",
      when: () => filterPaletteOpen,
      stopPropagation: true,
      handler: () => {
        const { options } = getPaletteConfig(filterPaletteKind);
        const opt = options[filterPaletteIndex];
        if (opt) {
          applyPaletteValue(filterPaletteKind, opt.value);
          closeFilterPalette();
        }
      },
    },
    {
      when: () => filterPaletteOpen,
      preventDefault: false,
      stopPropagation: true,
      handler: () => {},
    },
    {
      key: ["ArrowDown", "ArrowUp"],
      mod: true,
      handler: ({ event }) => {
        const dir = event.key === "ArrowDown" ? 1 : -1;
        const from = currentTabRef.current < 0 ? 0 : currentTabRef.current;
        const next = (from + dir + TABS.length) % TABS.length;
        navigate({ pathname: TABS[next].path, search: "" });
      },
    },
    {
      key: TABS.map((tab) => tab.key),
      mod: true,
      handler: ({ event }) => {
        const tab = TABS.find((t) => t.key === event.key);
        if (tab) navigate({ pathname: tab.path, search: "" });
      },
    },
    {
      key: "k",
      mod: true,
      handler: () => {
        inputRef.current?.focus();
      },
    },
    {
      key: "/",
      when: ({ isTextInput, isSelect }) => !isTextInput && !isSelect,
      handler: () => {
        inputRef.current?.focus();
      },
    },
  ], { priority: 20 });

  useEffect(() => {
    inputRef.current?.focus();
  }, [location.pathname]);

  useEffect(() => {
    const refocus = () => inputRef.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, []);

  const filterBar = (() => {
    if (isSearchPage) {
      const q = searchParams.get("q") ?? "";
      const stype = searchParams.has("stype")
        ? searchParams.get("stype") ?? ""
        : DEFAULT_SEARCH_TYPE;
      return (
        <>
          <div className="relative flex-1 max-w-md">
            <SearchIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"
            />
            <input
              ref={inputRef}
              key={location.pathname}
              defaultValue={q}
              placeholder="搜索条目…"
              className="w-full pl-9 pr-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
              onInput={(e) => {
                const val = e.currentTarget.value.trim();
                if (!val && q) {
                  const params = new URLSearchParams(searchParams);
                  params.delete("q");
                  setSearchParams(params);
                }
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const val = e.currentTarget.value.trim();
                if (val && val !== q) {
                  e.nativeEvent.stopImmediatePropagation();
                  const params = new URLSearchParams();
                  params.set("q", val);
                  if (searchParams.has("stype")) {
                    params.set("stype", searchParams.get("stype") ?? "");
                  }
                  setSearchParams(params);
                }
              }}
            />
          </div>
          <CustomSelect options={SUBJECT_TYPES} value={stype} onChange={() => openFilterPalette("search")} />
        </>
      );
    }

    if (isCalendar) {
      const filter = searchParams.get("filter") ?? "";
      const weekday = searchParams.get("weekday") ?? "";
      return (
        <>
          <div className="relative flex-1 max-w-md">
            <SearchIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"
            />
            <input
              ref={inputRef}
              key={location.pathname}
              defaultValue={filter}
              placeholder="筛选日历…"
              className="w-full pl-9 pr-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
              onInput={(e) => {
                const v = e.currentTarget.value;
                const params = new URLSearchParams(searchParams);
                if (v) params.set("filter", v);
                else params.delete("filter");
                setSearchParams(params, { replace: true });
              }}
            />
          </div>
          <CustomSelect options={CALENDAR_WEEKDAYS} value={weekday} onChange={() => openFilterPalette("calendar")} />
        </>
      );
    }

    if (isCollections) {
      const filter = searchParams.get("filter") ?? "";
      const type = searchParams.get("type") ?? "3";
      return (
        <>
          <div className="relative flex-1 max-w-md">
            <SearchIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"
            />
            <input
              ref={inputRef}
              key={location.pathname}
              defaultValue={filter}
              placeholder="筛选收藏…"
              className="w-full pl-9 pr-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
              onInput={(e) => {
                const v = e.currentTarget.value;
                const params = new URLSearchParams(searchParams);
                if (v) params.set("filter", v);
                else params.delete("filter");
                setSearchParams(params, { replace: true });
              }}
            />
          </div>
          <CustomSelect options={COLLECTION_TYPES} value={type} onChange={() => openFilterPalette("collections")} />
        </>
      );
    }

    if (isNextSeason) {
      const filter = searchParams.get("filter") ?? "";
      const weekday = searchParams.get("weekday") ?? "";
      return (
        <>
          <div className="relative flex-1 max-w-md">
            <SearchIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"
            />
            <input
              ref={inputRef}
              key={location.pathname}
              defaultValue={filter}
              placeholder="筛选新番…"
              className="w-full pl-9 pr-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
              onInput={(e) => {
                const v = e.currentTarget.value;
                const params = new URLSearchParams(searchParams);
                if (v) params.set("filter", v);
                else params.delete("filter");
                setSearchParams(params, { replace: true });
              }}
            />
          </div>
          <CustomSelect options={NEXT_SEASON_WEEKDAYS} value={weekday} onChange={() => openFilterPalette("next-season")} />
        </>
      );
    }

    return <h1 className="text-[13px] font-medium text-fg-secondary">设置</h1>;
  })();

  const { options: paletteOptions, currentValue: paletteCurrentValue, title: paletteTitle } = getPaletteConfig(filterPaletteKind);

  return (
    <div className="h-screen flex text-fg overflow-hidden">
      <aside
        className={`shrink-0 flex flex-col bg-panel border-r border-line transition-all duration-150 ease-in-out ${
          collapsed ? "w-[60px]" : "w-[196px]"
        }`}
      >
        <div
          className="flex items-center gap-2.5 h-12 px-3.5 shrink-0"
          data-tauri-drag-region
          onMouseDown={handleHeaderMouseDown}
        >
          <img src="/icon.png" className="w-7 h-7 shrink-0 rounded-lg" alt="" />
          {!collapsed && (
            <span className="font-semibold text-[14px] tracking-tight truncate">
              Bangumini
            </span>
          )}
        </div>

        <nav className="flex-1 px-2.5 py-2 space-y-0.5">
          {TABS.map((tab, i) => {
            const active = i === currentTab;
            return (
              <button
                key={tab.path}
                onClick={() => navigate({ pathname: tab.path, search: "" })}
                title={collapsed ? tab.label : undefined}
                className={`group relative w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-[13px] transition-colors ${
                  active
                    ? "bg-selected text-fg"
                    : "text-fg-secondary hover:bg-hover hover:text-fg"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
                )}
                <tab.Icon size={18} className="shrink-0" />
                {!collapsed && <span className="truncate">{tab.label}</span>}
                {!collapsed && (
                  <kbd className="ml-auto text-[11px] text-fg-tertiary opacity-0 group-hover:opacity-100 transition-opacity">
                    {MOD}{tab.key}
                  </kbd>
                )}
              </button>
            );
          })}
        </nav>

        <button
          onClick={() => setCollapsed((v) => !v)}
          title="折叠侧边栏 (Tab)"
          className="m-2.5 flex items-center gap-3 px-2.5 py-2 rounded-md text-fg-tertiary hover:bg-hover hover:text-fg-secondary transition-colors"
        >
          <SidebarIcon size={18} className="shrink-0" />
          {!collapsed && <span className="text-[13px]">折叠</span>}
        </button>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center gap-2 h-12 px-4 border-b border-line shrink-0"
          data-tauri-drag-region
          onMouseDown={handleHeaderMouseDown}
          onDoubleClick={(e) => e.preventDefault()}
        >
          {filterBar}
          <FetchIndicator />
        </header>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>

        {isFetching && (
          <div className="shrink-0 h-0.5 bg-line overflow-hidden">
            <div className="h-full w-full shimmer-bar" />
          </div>
        )}

        <footer className="flex items-center gap-4 h-9 px-4 border-t border-line shrink-0 bg-panel/40">
          <KeyHint k="↵" label="打开" />
          <KeyHint k={`${MOD}+↵`} label="复制名称" />
          <KeyHint k="↑↓" label="选择" />
          <KeyHint k={`${MOD}+←→`} label="翻页" />
          <KeyHint k={`${MOD}+↑↓`} label="切标签" />
          <KeyHint k="Tab" label="侧边栏" />
          {isCollections && <KeyHint k={`${MOD}+R`} label="刷新缓存" />}
        </footer>
      </div>

      {filterPaletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[25vh]">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeFilterPalette}
          />
          <div className="relative w-64 bg-elevated rounded-xl border border-line-strong shadow-pop overflow-hidden">
            <div className="px-4 pt-3 pb-2">
              <span className="text-[12px] font-semibold text-fg">{paletteTitle}</span>
            </div>
            <div className="px-2 pb-1">
              {paletteOptions.map((opt, i) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    applyPaletteValue(filterPaletteKind, opt.value);
                    closeFilterPalette();
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-left transition-colors ${
                    i === filterPaletteIndex
                      ? "bg-accent text-accent-fg"
                      : "text-fg-secondary hover:bg-hover"
                  }`}
                >
                  {opt.value === paletteCurrentValue && (
                    <span className={`w-3.5 text-center text-[11px] ${i === filterPaletteIndex ? "text-accent-fg" : "text-accent"}`}>●</span>
                  )}
                  {opt.value !== paletteCurrentValue && <span className="w-3.5" />}
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
            <div className="px-3 py-1.5 text-[11px] text-fg-tertiary border-t border-line/50">
              ↑↓ 导航 · Enter 选择 · Esc 关闭
            </div>
          </div>
        </div>
      )}

      <SyncQueueDock />
    </div>
  );
}
