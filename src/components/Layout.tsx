import { useEffect, useRef } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";

const TABS = [
  { path: "/", label: "搜索", key: "1" },
  { path: "/calendar", label: "日历", key: "2" },
  { path: "/collections", label: "收藏", key: "3" },
  { path: "/settings", label: "设置", key: "4" },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT") return; // don't intercept typing

      // Tab navigation
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

  return (
    <div className="h-screen flex flex-col bg-[#1a1a2e] text-gray-200">
      <header className="flex items-center gap-1 px-4 py-2 border-b border-gray-800 shrink-0">
        <span className="text-indigo-400 font-bold mr-3 text-sm">Bangumini</span>
        <div className="flex gap-0.5 bg-gray-800/50 rounded-lg p-0.5">
          {TABS.map((tab, i) => (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${i === currentTab ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-200"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <input
          ref={inputRef}
          placeholder="输入关键字搜索（可输入拼音）…"
          className="ml-auto w-64 px-3 py-1 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500 focus:border-indigo-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.currentTarget.value) {
              navigate(`/?q=${encodeURIComponent(e.currentTarget.value)}`);
            }
          }}
        />
      </header>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
