import { getPref } from "./prefs";

export function hexToRgba(hex: string, opacityPct: number): string {
  let h = String(hex || "").trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = "00b450";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  let a = Number(opacityPct);
  if (!Number.isFinite(a)) a = 55;
  a = Math.max(0, Math.min(100, a)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

export function darkenHex(hex: string): string {
  let h = String(hex || "").trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = "00b450";
  const r = Math.max(0, Math.round(parseInt(h.slice(0, 2), 16) * 0.65));
  const g = Math.max(0, Math.round(parseInt(h.slice(2, 4), 16) * 0.65));
  const b = Math.max(0, Math.round(parseInt(h.slice(4, 6), 16) * 0.65));
  return `rgba(${r}, ${g}, ${b}, 0.75)`;
}

export function readPrefSafe<T>(key: any, fallback: T): T {
  try {
    const v = getPref(key);
    if (v === undefined || v === null) return fallback;
    return v as unknown as T;
  } catch {
    return fallback;
  }
}
