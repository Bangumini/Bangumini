import { useEffect } from "react";
import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { setTokenProvider } from "@shared/api/client";
import { getAccessToken, fetchAndCacheUsername } from "./api/oauth";
import { useAuth } from "./hooks/useAuth";
import { isTauri } from "./api/tauri-fetch";
import { DEFAULT_SHORTCUT, loadStoredShortcut } from "./api/shortcut";
import { cleanupExpiredCache } from "@shared/storage/sqlite-cache";
import Layout from "./components/Layout";
import SearchPage from "./pages/SearchPage";
import CalendarPage from "./pages/CalendarPage";
import CollectionsPage from "./pages/CollectionsPage";
import SubjectDetailPage from "./pages/SubjectDetailPage";
import NextSeasonPage from "./pages/NextSeasonPage";
import LoginPage from "./pages/LoginPage";
import SettingsPage from "./pages/SettingsPage";

setTokenProvider(getAccessToken);

function RequireAuth() {
  const { authenticated } = useAuth();
  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

export default function App() {
  const { authLoading, authenticated, handleLogin } = useAuth();

  useEffect(() => {
    if (authenticated) {
      fetchAndCacheUsername().catch(() => {});
    }
  }, [authenticated]);

  useEffect(() => {
    if (!isTauri()) return;
    const stored = loadStoredShortcut();
    if (stored === DEFAULT_SHORTCUT) return;
    invoke("register_shortcut", { accelerator: stored }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    cleanupExpiredCache()
      .then((localPaths) => {
        if (localPaths.length > 0) {
          return invoke("delete_cached_files", { localPaths });
        }
        return undefined;
      })
      .catch(() => {});
  }, []);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <span className="text-fg-tertiary text-[13px]">加载中…</span>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={
        authenticated ? <Navigate to="/collections" replace /> : <LoginPage onLogin={handleLogin} />
      } />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/collections" replace />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/next-season" element={<NextSeasonPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/subject/:id" element={<SubjectDetailPage />} />
      </Route>
    </Routes>
  );
}
