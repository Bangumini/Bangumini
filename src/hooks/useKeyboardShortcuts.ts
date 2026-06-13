import { useEffect, useRef } from "react";

type ShortcutContext = {
  event: KeyboardEvent;
  target: HTMLElement | null;
  mod: boolean;
  isInput: boolean;
  isTextInput: boolean;
  isSelect: boolean;
  isEditable: boolean;
};

export type KeyboardShortcut = {
  key?: string | readonly string[];
  mod?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  stopImmediatePropagation?: boolean;
  when?: (context: ShortcutContext) => boolean;
  handler: (context: ShortcutContext) => void;
};

type ShortcutOptions = {
  enabled?: boolean;
  capture?: boolean;
  priority?: number;
};

type ShortcutRegistration = {
  id: number;
  capture: boolean;
  priority: number;
  getShortcuts: () => readonly KeyboardShortcut[];
};

const registrations = new Map<number, ShortcutRegistration>();
let nextRegistrationId = 1;
let bubbleListening = false;
let captureListening = false;

function getKeyboardContext(event: KeyboardEvent): ShortcutContext {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const tagName = target?.tagName;
  const isTextInput = tagName === "INPUT" || tagName === "TEXTAREA";
  const isSelect = tagName === "SELECT";
  const isEditable = Boolean(isTextInput || isSelect || target?.isContentEditable);

  return {
    event,
    target,
    mod: event.ctrlKey || event.metaKey,
    isInput: Boolean(isTextInput || isSelect),
    isTextInput,
    isSelect,
    isEditable,
  };
}

function keyMatches(shortcutKey: string | readonly string[] | undefined, eventKey: string) {
  if (!shortcutKey) return true;
  if (Array.isArray(shortcutKey)) return shortcutKey.includes(eventKey);
  return shortcutKey === eventKey;
}

function modifierMatches(actual: boolean, expected: boolean | undefined) {
  return expected === undefined || actual === expected;
}

function shortcutMatches(shortcut: KeyboardShortcut, context: ShortcutContext) {
  const { event } = context;
  return (
    keyMatches(shortcut.key, event.key) &&
    modifierMatches(context.mod, shortcut.mod) &&
    modifierMatches(event.ctrlKey, shortcut.ctrl) &&
    modifierMatches(event.metaKey, shortcut.meta) &&
    modifierMatches(event.altKey, shortcut.alt) &&
    modifierMatches(event.shiftKey, shortcut.shift) &&
    (shortcut.when?.(context) ?? true)
  );
}

function sortedRegistrations(capture: boolean) {
  return [...registrations.values()]
    .filter((registration) => registration.capture === capture)
    .sort((a, b) => b.priority - a.priority || b.id - a.id);
}

function dispatchKeyboardShortcuts(event: KeyboardEvent, capture: boolean) {
  const context = getKeyboardContext(event);

  for (const registration of sortedRegistrations(capture)) {
    for (const shortcut of registration.getShortcuts()) {
      if (!shortcutMatches(shortcut, context)) continue;

      if (shortcut.preventDefault ?? true) event.preventDefault();
      if (shortcut.stopPropagation) event.stopPropagation();
      if (shortcut.stopImmediatePropagation) event.stopImmediatePropagation();
      shortcut.handler(context);
      return;
    }
  }
}

function ensureKeyboardListener(capture: boolean) {
  if (capture) {
    if (captureListening) return;
    window.addEventListener("keydown", handleCaptureKeyDown, true);
    captureListening = true;
    return;
  }

  if (bubbleListening) return;
  window.addEventListener("keydown", handleBubbleKeyDown);
  bubbleListening = true;
}

function handleBubbleKeyDown(event: KeyboardEvent) {
  dispatchKeyboardShortcuts(event, false);
}

function handleCaptureKeyDown(event: KeyboardEvent) {
  dispatchKeyboardShortcuts(event, true);
}

function removeKeyboardListenerIfUnused(capture: boolean) {
  const hasRegistrations = [...registrations.values()].some(
    (registration) => registration.capture === capture,
  );
  if (hasRegistrations) return;

  if (capture && captureListening) {
    window.removeEventListener("keydown", handleCaptureKeyDown, true);
    captureListening = false;
  } else if (!capture && bubbleListening) {
    window.removeEventListener("keydown", handleBubbleKeyDown);
    bubbleListening = false;
  }
}

function registerKeyboardShortcuts(
  getShortcuts: () => readonly KeyboardShortcut[],
  options: Required<Pick<ShortcutOptions, "capture" | "priority">>,
) {
  const id = nextRegistrationId;
  nextRegistrationId += 1;
  registrations.set(id, {
    id,
    getShortcuts,
    capture: options.capture,
    priority: options.priority,
  });
  ensureKeyboardListener(options.capture);

  return () => {
    registrations.delete(id);
    removeKeyboardListenerIfUnused(options.capture);
  };
}

export function useKeyboardShortcuts(
  shortcuts: readonly KeyboardShortcut[],
  options: ShortcutOptions = {},
) {
  const shortcutsRef = useRef(shortcuts);
  const enabled = options.enabled ?? true;
  const capture = options.capture ?? false;
  const priority = options.priority ?? 0;

  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    if (!enabled) return;
    return registerKeyboardShortcuts(() => shortcutsRef.current, { capture, priority });
  }, [capture, enabled, priority]);
}
