import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SHORTCUT,
  eventToAccelerator,
  formatAccelerator,
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
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
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
          className={`flex-1 px-3 py-2 text-sm rounded-md border text-left font-mono ${
            recording
              ? "border-indigo-500 bg-indigo-500/10 text-indigo-200"
              : "border-gray-700 bg-gray-800 text-gray-200 hover:border-gray-600"
          }`}
        >
          {display}
        </button>
        <button
          onClick={reset}
          className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-md text-gray-300 border border-gray-700"
        >
          恢复默认
        </button>
      </div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      {!error && (
        <p className="text-xs text-gray-600 mt-1">
          点击后按下组合键录制；至少包含一个修饰键（Ctrl / Alt / Shift / Cmd）
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
  if (part === "Cmd") return "⌘";
  if (part === "Shift") return "⇧";
  if (part === "Alt") return "⌥";
  return part;
}
