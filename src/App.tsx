import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { setTokenProvider } from "@shared/api/client";
import { getAccessToken, fetchAndCacheUsername } from "./api/oauth";
import { useAuth } from "./hooks/useAuth";
import Layout from "./components/Layout";
import SearchPage from "./pages/SearchPage";
import CalendarPage from "./pages/CalendarPage";
import CollectionsPage from "./pages/CollectionsPage";
import SubjectDetailPage from "./pages/SubjectDetailPage";
import LoginPage from "./pages/LoginPage";
import SettingsPage from "./pages/SettingsPage";

setTokenProvider(getAccessToken);

export default function App() {
  const { authLoading, authenticated, handleLogin } = useAuth();

  useEffect(() => {
    if (authenticated) {
      fetchAndCacheUsername().catch(() => {});
    }
  }, [authenticated]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#1a1a2e]">
        <span className="text-gray-400">加载中...</span>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<SearchPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="/subject/:id" element={<SubjectDetailPage />} />
    </Routes>
  );
}
