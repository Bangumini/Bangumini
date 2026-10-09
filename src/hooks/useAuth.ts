import { useEffect, useState } from "react";
import { AUTH_INVALIDATED_EVENT, isLoggedIn } from "../api/oauth";

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(() => isLoggedIn());

  useEffect(() => {
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
