import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textOf(record["#cdata"] ?? record["#text"] ?? record["_"]);
  }
  return "";
}

export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, "\"")
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "podcast";
}

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function episodeKey(seed: string): string {
  const readable = slugify(seed).slice(0, 50);
  const hash = sha1(seed).slice(0, 12);
  return readable ? `${readable}-${hash}` : hash;
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override == null) return structuredClone(base);
  if (Array.isArray(base) || Array.isArray(override)) return structuredClone(override as T);
  if (typeof base !== "object" || typeof override !== "object") return structuredClone(override as T);
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const existing = out[key];
    out[key] =
      existing != null && typeof existing === "object" && !Array.isArray(existing)
        ? deepMerge(existing, value)
        : structuredClone(value);
  }
  return out as T;
}

export function parseDuration(value: unknown): number | undefined {
  const raw = textOf(value).trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function parseTimestamp(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  const last = Number(parts.pop() ?? "0");
  const minutes = Number(parts.pop() ?? "0");
  const hours = Number(parts.pop() ?? "0");
  if ([last, minutes, hours].some(Number.isNaN)) return 0;
  return hours * 3600 + minutes * 60 + last;
}

export function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const millis = Math.round((safe - whole) * 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveFrom(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function absoluteUrl(baseUrl: string, route: string): string {
  return new URL(route, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export function isRecent(date: Date | undefined, lookbackDays: number, now = new Date()): boolean {
  if (!date) return true;
  const cutoff = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}
