import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  SearchIcon,
  CalendarIcon,
  BookmarkIcon,
  SettingsIcon,
  SidebarIcon,
} from "./icons";
import { MOD } from "../api/shortcut";

const TABS = [
  { path: "/collections", label: "收藏", key: "1", Icon: BookmarkIcon },
  { path: "/calendar", label: "日历", key: "2", Icon: CalendarIcon },
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

const selectClass =
  "appearance-none bg-elevated border border-line rounded-md pl-2.5 pr-7 py-1.5 text-[13px] text-fg-secondary hover:text-fg focus:border-accent focus:outline-none bg-[length:12px] bg-no-repeat bg-[right_0.5rem_center]";
// Down-chevron rendered as an inline SVG data URI so native <select> matches the theme.
const selectArrow =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

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

  const isSearchPage = location.pathname === "/search";
  const isCollections = location.pathname === "/collections";
  const isCalendar = location.pathname === "/calendar";
  const currentTab = TABS.findIndex((t) => t.path === location.pathname);
  const currentTabRef = useRef(currentTab);
  currentTabRef.current = currentTab;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT";
      const isSelect = target.tagName === "SELECT";
      const mod = e.metaKey || e.ctrlKey;

      // Tab toggles the sidebar (prevent default tab behavior on input)
      if (e.key === "Tab" && !mod && !e.altKey) {
        e.preventDefault();
        setCollapsed((v) => !v);
        return;
      }

      // Ctrl/Cmd + P opens filter palette
      if (mod && e.key === "p") {
        e.preventDefault();
        setFilterPaletteOpen((prev) => !prev);
        setFilterPaletteIndex(0);
        return;
      }

      // Filter palette navigation
      if (filterPaletteOpen) {
        const options = isSearchPage ? SUBJECT_TYPES : isCollections ? COLLECTION_TYPES : isCalendar ? CALENDAR_WEEKDAYS : [];
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          setFilterPaletteIndex((i) => Math.min(options.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setFilterPaletteIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const opt = options[filterPaletteIndex];
          if (opt) {
            const params = new URLSearchParams(searchParams);
            if (isSearchPage) {
              if (opt.value) params.set("stype", opt.value);
              else params.delete("stype");
            } else if (isCollections) {
              params.set("type", opt.value);
              params.delete("filter");
            } else if (isCalendar) {
              if (opt.value) params.set("weekday", opt.value);
              else params.delete("weekday");
              params.delete("filter");
            }
            setSearchParams(params, { replace: true });
            setFilterPaletteOpen(false);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setFilterPaletteOpen(false);
          return;
        }
        // Block all other keys when palette is open
        e.stopPropagation();
        return;
      }

      // Ctrl/Cmd + Up/Down cycles through sidebar tabs (works even while typing)
      if (mod && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const from = currentTabRef.current < 0 ? 0 : currentTabRef.current;
        const next = (from + dir + TABS.length) % TABS.length;
        navigate({ pathname: TABS[next].path, search: "" });
        return;
      }

      // Ctrl/Cmd + 1..4 jumps to a tab; Ctrl/Cmd + K refocuses the input.
      // Both work even while typing so navigation never requires leaving the input.
      if (mod) {
        const tab = TABS.find((t) => t.key === e.key);
        if (tab) {
          e.preventDefault();
          navigate({ pathname: tab.path, search: "" });
          return;
        }
        if (e.key === "k") {
          e.preventDefault();
          inputRef.current?.focus();
          return;
        }
      }

      if (isInput || isSelect) return;

      // "/" jumps into the input when focus happens to be elsewhere
      if (e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, filterPaletteOpen, filterPaletteIndex, isSearchPage, isCollections, isCalendar, searchParams, setSearchParams]);

  // Persistent input: keep the page's search/filter box focused so the user can
  // type immediately on every page and after the window is re-summoned.
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
      const stype = searchParams.get("stype") ?? "2";
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
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const val = e.currentTarget.value.trim();
                // Only (re)submit when the query actually changed. For an
                // unchanged query, let the event reach SearchPage so Enter
                // opens the currently focused result instead of re-searching.
                if (val && val !== q) {
                  e.nativeEvent.stopImmediatePropagation();
                  const params = new URLSearchParams();
                  params.set("q", val);
                  if (stype) params.set("stype", stype);
                  setSearchParams(params);
                }
              }}
            />
          </div>
          <select
            value={stype}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              if (e.target.value) params.set("stype", e.target.value);
              else params.delete("stype");
              setSearchParams(params, { replace: true });
            }}
            className={selectClass}
            style={{ backgroundImage: selectArrow }}
          >
            {SUBJECT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
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
              onChange={(e) => {
                const v = e.target.value;
                const params = new URLSearchParams(searchParams);
                if (v) params.set("filter", v);
                else params.delete("filter");
                setSearchParams(params, { replace: true });
              }}
            />
          </div>
          <select
            value={weekday}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              if (e.target.value) params.set("weekday", e.target.value);
              else params.delete("weekday");
              params.delete("filter");
              setSearchParams(params, { replace: true });
            }}
            className={selectClass}
            style={{ backgroundImage: selectArrow }}
          >
            {CALENDAR_WEEKDAYS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
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
              onChange={(e) => {
                const v = e.target.value;
                const params = new URLSearchParams(searchParams);
                if (v) params.set("filter", v);
                else params.delete("filter");
                setSearchParams(params, { replace: true });
              }}
            />
          </div>
          <select
            value={type}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              params.set("type", e.target.value);
              params.delete("filter");
              setSearchParams(params, { replace: true });
            }}
            className={selectClass}
            style={{ backgroundImage: selectArrow }}
          >
            {COLLECTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </>
      );
    }

    return <h1 className="text-[13px] font-medium text-fg-secondary">设置</h1>;
  })();

  return (
    <div className="h-screen flex text-fg overflow-hidden">
      {/* Sidebar */}
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
          <div className="w-7 h-7 shrink-0 rounded-lg bg-accent/90 flex items-center justify-center text-accent-fg text-[13px] font-bold">
            B
          </div>
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

      {/* Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center gap-2 h-12 px-4 border-b border-line shrink-0"
          data-tauri-drag-region
          onMouseDown={handleHeaderMouseDown}
          onDoubleClick={(e) => e.preventDefault()}
        >
          {filterBar}
        </header>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>

        <footer className="flex items-center gap-4 h-9 px-4 border-t border-line shrink-0 bg-panel/40">
          <KeyHint k="↵" label="打开" />
          <KeyHint k={`${MOD}↵`} label="复制名称" />
          <KeyHint k="↑↓" label="选择" />
          <KeyHint k={`${MOD}←→`} label="翻页" />
          <KeyHint k={`${MOD}↑↓`} label="切标签" />
          <KeyHint k="Tab" label="侧边栏" />
        </footer>
      </div>

      {/* Filter Palette Overlay */}
      {filterPaletteOpen && (() => {
        const options = isSearchPage ? SUBJECT_TYPES : isCollections ? COLLECTION_TYPES : isCalendar ? CALENDAR_WEEKDAYS : [];
        const currentValue = isSearchPage
          ? searchParams.get("stype") ?? "2"
          : isCollections
            ? searchParams.get("type") ?? "3"
            : searchParams.get("weekday") ?? "";
        const title = isSearchPage ? "条目类型" : isCollections ? "收藏状态" : "星期筛选";

        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setFilterPaletteOpen(false)} />
            <div className="relative w-80 bg-elevated border border-line-strong rounded-card shadow-pop overflow-hidden">
              <div className="px-3 py-2 text-[12px] text-fg-tertiary border-b border-line">
                {title} · 按回车选择
              </div>
              <div className="p-1.5">
                {options.map((opt, i) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      const params = new URLSearchParams(searchParams);
                      if (isSearchPage) {
                        if (opt.value) params.set("stype", opt.value);
                        else params.delete("stype");
                      } else if (isCollections) {
                        params.set("type", opt.value);
                        params.delete("filter");
                      } else if (isCalendar) {
                        if (opt.value) params.set("weekday", opt.value);
                        else params.delete("weekday");
                        params.delete("filter");
                      }
                      setSearchParams(params, { replace: true });
                      setFilterPaletteOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] text-left transition-colors ${
                      i === filterPaletteIndex
                        ? "bg-accent text-accent-fg"
                        : opt.value === currentValue
                          ? "bg-accent-soft text-accent"
                          : "text-fg-secondary hover:bg-hover"
                    }`}
                  >
                    <span>{opt.label}</span>
                    {opt.value === currentValue && (
                      <span className="ml-auto text-[11px] opacity-70">当前</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="px-3 py-2 text-[12px] text-fg-tertiary border-t border-line">
                ↑↓ 导航 · Enter 选择 · Esc 关闭
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
