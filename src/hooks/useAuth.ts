import { useSyncExternalStore } from "react";
import {
  AUTH_CHANGED_EVENT, AUTH_INVALIDATED_EVENT, getAuthSessionRevision, getUsername, isLoggedIn,
} from "../api/oauth";

function snapshot(): string {
  return JSON.stringify([isLoggedIn(), getUsername(), getAuthSessionRevision()]);
}
function subscribe(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === null || ["bangumi_token", "bangumi_username"].includes(event.key)) listener();
  };
  window.addEventListener(AUTH_INVALIDATED_EVENT, listener);
  window.addEventListener(AUTH_CHANGED_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(AUTH_INVALIDATED_EVENT, listener);
    window.removeEventListener(AUTH_CHANGED_EVENT, listener);
    window.removeEventListener("storage", storage);
  };
}

export function useAuth() {
  const raw = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [authenticated, username, sessionRevision] = JSON.parse(raw) as [boolean, string, number];
  function handleLogin() {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    return isLoggedIn();
  }
  return { authLoading: false, authenticated, username, sessionRevision, handleLogin };
}
