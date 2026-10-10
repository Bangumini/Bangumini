import { useEffect, useState } from "react";
import { AUTH_INVALIDATED_EVENT, isLoggedIn } from "../api/oauth";

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(() => isLoggedIn());

  useEffect(() => {
    // 即使挂载时未登录也要监听，确保随后登录的会话能够正常退出。
    const handleAuthInvalidated = () => setAuthenticated(false);
    window.addEventListener(AUTH_INVALIDATED_EVENT, handleAuthInvalidated);
    return () =>
      window.removeEventListener(AUTH_INVALIDATED_EVENT, handleAuthInvalidated);
  }, []);

  function handleLogin() {
    const ok = isLoggedIn();
    setAuthenticated(ok);
    return ok;
  }

  return { authLoading: false, authenticated, handleLogin };
}
