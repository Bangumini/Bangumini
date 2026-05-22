const TOKEN_KEY = "bangumi_token";

export function isLoggedIn(): boolean {
  return !!localStorage.getItem(TOKEN_KEY);
}

export function getAccessToken(): string {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) throw new Error("Not authenticated");
  return token;
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
