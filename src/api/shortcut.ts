// Shortcut helpers: convert KeyboardEvent <-> Tauri accelerator string
// Tauri accelerator format: "CmdOrCtrl+Shift+B"

const SHORTCUT_KEY = "bangumini_shortcut";
export const DEFAULT_SHORTCUT = "CmdOrCtrl+Shift+B";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export { isMac };

// Platform-appropriate label for the primary modifier used by in-app shortcuts
// (bound to Ctrl on Windows/Linux, Cmd on macOS).
export const MOD = isMac ? "⌘" : "Ctrl";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

export interface ParsedShortcut {
  accelerator: string;
  display: string;
}

export function loadStoredShortcut(): string {
  return localStorage.getItem(SHORTCUT_KEY) || DEFAULT_SHORTCUT;
}

export function saveStoredShortcut(accelerator: string) {
  localStorage.setItem(SHORTCUT_KEY, accelerator);
}

// Convert a KeyboardEvent into a Tauri accelerator string.
// Returns null if the event doesn't form a valid shortcut yet
// (e.g. user only pressed a modifier).
export function eventToAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.metaKey) mods.push(isMac ? "Cmd" : "Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const key = normalizeKey(e);
  if (!key) return null;

  // Require at least one modifier to avoid accidentally registering bare keys
  // that would block normal typing globally.
  if (mods.length === 0) return null;

  return [...mods, key].join("+");
}

function normalizeKey(e: KeyboardEvent): string | null {
  const code = e.code;

  // Letters: KeyA -> A
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3);
  }
  // Digits (top row): Digit1 -> 1
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  // Function keys F1..F24
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) {
    return code;
  }
  // Named keys
  const named: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
  };
  return named[code] ?? null;
}

// Pretty-print an accelerator for the UI. Replaces "CmdOrCtrl"/"Cmd" with the
// platform-appropriate symbol, and uses a thin separator.
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split("+");
  return parts
    .map((p) => {
      if (p === "CmdOrCtrl") return isMac ? "⌘" : "Ctrl";
      if (p === "Cmd" || p === "Meta") return isMac ? "⌘" : "Win";
      if (p === "Ctrl" || p === "Control") return "Ctrl";
      if (p === "Alt") return isMac ? "⌥" : "Alt";
      if (p === "Shift") return isMac ? "⇧" : "Shift";
      if (p === "Super") return "Win";
      return p;
    })
    .join(" + ");
}
