"use client";

import { useCallback, useSyncExternalStore } from "react";

export type CanvasPreferences = {
  theme: "dark" | "light" | "custom";
  grid: "dots" | "lines" | "blank";
  snap: boolean;
  links: boolean;
  miniMap: boolean;
  tool: "select" | "hand";
  custom: { light: boolean; background: string; brightness: number; gridColor: string; gridStrength: number };
};
export const defaultPreferences: CanvasPreferences = {
  theme: "dark", grid: "dots", snap: false, links: true, miniMap: false, tool: "select",
  custom: { light: false, background: "#141414", brightness: 100, gridColor: "#afafaf", gridStrength: 30 },
};
const prefix = "modmind:canvas-appearance:v1:";
const eventName = "modmind-canvas-preferences";
const cache = new Map<string, { raw: string | null; value: CanvasPreferences }>();
const memory = new Map<string, string>();
export const validHexColor = (value: string): boolean => /^#[\da-f]{6}$/i.test(value);

function read(key: string): CanvasPreferences {
  let raw = memory.get(key) ?? null;
  try { raw = localStorage.getItem(key) ?? raw; } catch { /* Tab memory remains available. */ }
  const saved = cache.get(key);
  if (saved?.raw === raw) return saved.value;
  let value = defaultPreferences;
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed && typeof parsed === "object") {
      const custom = parsed.custom ?? {};
      value = {
        theme: ["light", "dark", "custom"].includes(parsed.theme) ? parsed.theme : "dark",
        grid: ["dots", "lines", "blank"].includes(parsed.grid) ? parsed.grid : "dots",
        snap: parsed.snap === true, links: parsed.links !== false, miniMap: parsed.miniMap === true,
        tool: parsed.tool === "hand" ? "hand" : "select",
        custom: {
          light: custom.light === true,
          background: validHexColor(custom.background) ? custom.background : defaultPreferences.custom.background,
          brightness: typeof custom.brightness === "number" ? Math.min(140, Math.max(40, custom.brightness)) : 100,
          gridColor: validHexColor(custom.gridColor) ? custom.gridColor : defaultPreferences.custom.gridColor,
          gridStrength: typeof custom.gridStrength === "number" ? Math.min(100, Math.max(0, custom.gridStrength)) : 30,
        },
      };
    }
  } catch { /* Migrate invalid or older preferences to defaults. */ }
  cache.set(key, { raw, value });
  return value;
}
const subscribe = (listener: () => void) => {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(eventName, listener); };
};
export function useCanvasPreferences(userId: string) {
  const key = prefix + userId;
  const preferences = useSyncExternalStore(subscribe, () => read(key), () => defaultPreferences);
  const update = useCallback((patch: Partial<CanvasPreferences>) => {
    const raw = JSON.stringify({ ...read(key), ...patch });
    memory.set(key, raw);
    try { localStorage.setItem(key, raw); } catch { /* Keep current tab usable. */ }
    window.dispatchEvent(new Event(eventName));
  }, [key]);
  return [preferences, update] as const;
}

export function canvasTheme(_preferences: CanvasPreferences) {
  return { light: true, background: 'var(--theme-canvas)', gridColor: 'var(--theme-strong-line)', gridOpacity: .45 };
}
