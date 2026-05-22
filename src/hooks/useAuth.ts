import { useEffect, useState } from "react";
import { isLoggedIn } from "../api/oauth";

export function useAuth({ autoLogin }: { autoLogin?: boolean } = {}) {
  const [authLoading, setAuthLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    const ok = isLoggedIn();
    setAuthenticated(ok);
    setAuthLoading(false);
    if (!ok && autoLogin) {
      setAuthenticated(true); // Show login page instead of blocking
    }
  }, []);

  function handleLogin() {
    const ok = isLoggedIn();
    setAuthenticated(ok);
    return ok;
  }

  return { authLoading, authenticated, handleLogin };
}
