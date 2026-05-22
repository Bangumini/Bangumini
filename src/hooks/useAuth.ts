import { useEffect, useState } from "react";
import { isLoggedIn } from "../api/oauth";

export function useAuth() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    const ok = isLoggedIn();
    setAuthenticated(ok);
    setAuthLoading(false);
  }, []);

  function handleLogin() {
    const ok = isLoggedIn();
    setAuthenticated(ok);
    return ok;
  }

  return { authLoading, authenticated, handleLogin };
}
