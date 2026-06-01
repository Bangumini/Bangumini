import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DEFAULT_SHORTCUT,
  eventToAccelerator,
  formatAccelerator,
  isMac,
  loadStoredShortcut,
  saveStoredShortcut,
} from "../api/shortcut";

interface Props {
  className?: string;
}

export default function ShortcutRecorder({ className }: Props) {
  const [accelerator, setAccelerator] = useState<string>(loadStoredShortcut());
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;
    boxRef.current?.focus();

    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    const applyAccelerator = async (acc: string) => {
      try {
        await invoke("register_shortcut", { accelerator: acc });
        saveStoredShortcut(acc);
        setAccelerator(acc);
        setRecording(false);
        setDraft(null);
        setError(null);
      } catch (err) {
        setError(String(err));
        setDraft(null);
      }
    };

    // Native low-level keyboard hook (Windows): captures OS-reserved combos
    // like Alt+Space and Win+key that the webview never receives.
    invoke("start_hotkey_recording").catch(() => {});
    listen<string>("hotkey-recorded", (e) => {
      if (!cancelled) applyAccelerator(e.payload);
    }).then((un) => (cancelled ? un() : unlistenFns.push(un)));
    listen("hotkey-recording-cancel", () => {
      if (cancelled) return;
      setRecording(false);
      setDraft(null);
      setError(null);
    }).then((un) => (cancelled ? un() : unlistenFns.push(un)));

    // Fallback for platforms without the native hook: the webview keydown path.
    const onKeyDown = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        setDraft(null);
        setError(null);
        return;
      }

      const acc = eventToAccelerator(e);
      if (!acc) {
        setDraft(buildLiveDraft(e));
        return;
      }

      await applyAccelerator(acc);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Live preview clears once all modifiers are released
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setDraft(null);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      unlistenFns.forEach((fn) => fn());
      invoke("stop_hotkey_recording").catch(() => {});
    };
  }, [recording]);

  const reset = async () => {
    try {
      await invoke("register_shortcut", { accelerator: DEFAULT_SHORTCUT });
      saveStoredShortcut(DEFAULT_SHORTCUT);
      setAccelerator(DEFAULT_SHORTCUT);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const display = recording
    ? draft ?? "按下快捷键…  (Esc 取消)"
    : formatAccelerator(accelerator);

  return (
    <div className={className}>
      <div className="flex gap-2 items-center">
        <button
          ref={boxRef}
          onClick={() => {
            setRecording((v) => !v);
            setError(null);
            setDraft(null);
          }}
          className={`flex-1 px-3 py-2 text-[13px] rounded-md border text-left font-mono transition-colors ${
            recording
              ? "border-accent bg-accent-soft text-accent"
              : "border-line bg-elevated text-fg hover:border-line-strong"
          }`}
        >
          {display}
        </button>
        <button
          onClick={reset}
          className="px-3 py-2 text-[13px] bg-elevated hover:bg-hover rounded-md text-fg-secondary border border-line transition-colors"
        >
          恢复默认
        </button>
      </div>
      {error && <p className="text-[12px] text-danger mt-1.5">{error}</p>}
      {!error && (
        <p className="text-[12px] text-fg-tertiary mt-1.5">
          点击后按下组合键录制
        </p>
      )}
    </div>
  );
}

function buildLiveDraft(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.metaKey) mods.push("Cmd");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (mods.length === 0) return "按下快捷键…";
  return mods.map(humanize).join(" + ") + " + …";
}

function humanize(part: string): string {
  if (isMac) {
    if (part === "Cmd") return "⌘";
    if (part === "Shift") return "⇧";
    if (part === "Alt") return "⌥";
    return part;
  }
  if (part === "Cmd") return "Win";
  return part;
}
