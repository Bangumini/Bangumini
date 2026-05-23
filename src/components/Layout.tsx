import { useEffect, useRef } from "react";
import { Outlet, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const TABS = [
  { path: "/", label: "搜索", key: "1" },
  { path: "/calendar", label: "日历", key: "2" },
  { path: "/collections", label: "收藏", key: "3" },
  { path: "/settings", label: "设置", key: "4" },
];

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

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  const isSearchPage = location.pathname === "/";
  const isCollections = location.pathname === "/collections";
  const isCalendar = location.pathname === "/calendar";

  const handleHeaderMouseDown = async (e: React.MouseEvent) => {
    // Only drag on left button and not on interactive elements
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'SELECT') {
      return;
    }

    e.preventDefault();
    try {
      await invoke("set_dragging", { dragging: true });
      await getCurrentWindow().startDragging();
    } finally {
      // startDragging() blocks until drag ends
      await invoke("set_dragging", { dragging: false });
    }
  };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

      if (e.key === "1" && e.metaKey) { e.preventDefault(); navigate("/"); }
      if (e.key === "2" && e.metaKey) { e.preventDefault(); navigate("/calendar"); }
      if (e.key === "3" && e.metaKey) { e.preventDefault(); navigate("/collections"); }

      // Focus search
      if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const currentTab = TABS.findIndex((t) => t.path === location.pathname);

  const headerInput = (() => {
    if (isSearchPage) {
      const q = searchParams.get("q") ?? "";
      const stype = searchParams.get("stype") ?? "2";
      return (
        <div className="ml-auto flex gap-2">
          <input
            ref={inputRef}
            key={location.pathname}
            defaultValue={q}
            placeholder="搜索条目…"
            className="w-48 px-3 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.currentTarget.value.trim()) {
                const params = new URLSearchParams();
                params.set("q", e.currentTarget.value.trim());
                if (stype) params.set("stype", stype);
                setSearchParams(params);
              }
            }}
          />
          <select
            value={stype}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              if (e.target.value) params.set("stype", e.target.value);
              else params.delete("stype");
              setSearchParams(params, { replace: true });
            }}
            className="px-2 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 focus:border-indigo-500 focus:outline-none"
          >
            {SUBJECT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      );
    }

    if (isCalendar) {
      const filter = searchParams.get("filter") ?? "";
      const weekday = searchParams.get("weekday") ?? "";
      return (
        <div className="ml-auto flex gap-2">
          <input
            ref={inputRef}
            key={location.pathname}
            defaultValue={filter}
            placeholder="筛选日历…"
            className="w-44 px-3 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            onChange={(e) => {
              const v = e.target.value;
              const params = new URLSearchParams(searchParams);
              if (v) params.set("filter", v);
              else params.delete("filter");
              setSearchParams(params, { replace: true });
            }}
          />
          <select
            value={weekday}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              if (e.target.value) params.set("weekday", e.target.value);
              else params.delete("weekday");
              params.delete("filter");
              setSearchParams(params, { replace: true });
            }}
            className="px-2 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 focus:border-indigo-500 focus:outline-none"
          >
            {CALENDAR_WEEKDAYS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
      );
    }

    if (isCollections) {
      const filter = searchParams.get("filter") ?? "";
      const type = searchParams.get("type") ?? "3";
      return (
        <div className="ml-auto flex gap-2">
          <input
            ref={inputRef}
            key={location.pathname}
            defaultValue={filter}
            placeholder="筛选收藏…"
            className="w-44 px-3 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            onChange={(e) => {
              const v = e.target.value;
              const params = new URLSearchParams(searchParams);
              if (v) params.set("filter", v);
              else params.delete("filter");
              setSearchParams(params, { replace: true });
            }}
          />
          <select
            value={type}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              params.set("type", e.target.value);
              params.delete("filter");
              setSearchParams(params, { replace: true });
            }}
            className="px-2 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 focus:border-indigo-500 focus:outline-none"
          >
            {COLLECTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      );
    }

    return null;
  })();

  return (
    <div className="h-screen flex flex-col bg-[#1a1a2e] text-gray-200">
      <header
        className="flex items-center gap-1 px-4 py-2 border-b border-gray-800 shrink-0"
        onMouseDown={handleHeaderMouseDown}
        onDoubleClick={(e) => e.preventDefault()}
      >
        <span className="text-indigo-400 font-bold mr-3 text-sm">Bangumini</span>
        <div className="flex gap-0.5 bg-gray-800/50 rounded-lg p-0.5">
          {TABS.map((tab, i) => (
            <button
              key={tab.path}
              onClick={() => navigate({ pathname: tab.path, search: "" })}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${i === currentTab ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-200"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {headerInput}
      </header>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
