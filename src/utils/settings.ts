import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const FORMATS = [
  "mp3",
  "flac",
  "ogg",
  "aac",
  "m4a",
  "wav",
  "opus",
] as const;
export type Format = (typeof FORMATS)[number];

export const BITRATES = [128, 192, 256, 320] as const;
export type Bitrate = (typeof BITRATES)[number];

export interface Settings {
  /**
   * Preferred file formats in priority order.
   * "any" means no format filter — accept everything.
   */
  formats: Format[] | "any";
  /**
   * Minimum acceptable bitrate in kbps.
   * "any" means no minimum — accept any bitrate.
   */
  minBitrate: Bitrate | "any";
  /**
   * Preferred bitrate for ranking (not a hard filter).
   * Results at or above this get full score.
   * "any" normalizes to 0 (bitrate not weighted in ranking).
   */
  preferredBitrate: Bitrate | "any";
}

export const DEFAULT_SETTINGS: Settings = {
  formats: ["flac", "mp3"],
  minBitrate: 192,
  preferredBitrate: 320,
};

// ─── Persistence ──────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.resolve("settings.yaml");

function load(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = yaml.load(
      fs.readFileSync(SETTINGS_PATH, "utf8"),
    ) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(s: Settings): void {
  fs.writeFileSync(SETTINGS_PATH, yaml.dump(s), "utf8");
}

// In-memory cache — load once on startup
let _settings: Settings = load();

export function getSettings(): Settings {
  return _settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  _settings = { ..._settings, ...patch };
  save(_settings);
  return _settings;
}

export function resetSettings(): Settings {
  _settings = { ...DEFAULT_SETTINGS };
  save(_settings);
  return _settings;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatSettings(s: Settings): string {
  const fmt = s.formats === "any" ? "any" : s.formats.join(", ");
  const minBr = s.minBitrate === "any" ? "any" : `${s.minBitrate}kbps`;
  const prefBr =
    s.preferredBitrate === "any" ? "any" : `${s.preferredBitrate}kbps`;
  return [
    `**formats:** ${fmt}`,
    `**min bitrate:** ${minBr}`,
    `**preferred bitrate:** ${prefBr}`,
  ].join("\n");
}

/** Returns true if a file passes the hard filters (format + min bitrate). */
export function passesFilters(
  filename: string,
  bitrate: number | undefined,
  s: Settings,
): boolean {
  // Format filter
  if (s.formats !== "any") {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!s.formats.includes(ext as Format)) return false;
  }

  // Min bitrate filter
  if (s.minBitrate !== "any") {
    if (bitrate === undefined || bitrate < s.minBitrate) return false;
  }

  return true;
}
