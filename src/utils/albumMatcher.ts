/**
 * Album folder matching.
 *
 * Strategy:
 *   1. Group all files from search results by their parent folder path.
 *   2. Score each folder against the album tracklist:
 *      - Does the folder path contain the artist name?
 *      - Does the folder path contain the album name?
 *      - How many tracks match by title/position?
 *   3. Pick the best folder with the highest coverage.
 *   4. Map each MBTrack to the best matching file in that folder.
 */

import type { FileSearchResponse } from "../soulseek-ts/messages/from/peer.js";
import { FileAttribute } from "../soulseek-ts/messages/common.js";
import type { MBTrack } from "./musicbrainz.js";
import { normalize, similarity } from "./rank.js";
import type { Settings } from "./settings.js";
import { passesFilters } from "./settings.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FolderFile {
  username: string;
  filename: string; // full path as reported by peer
  folder: string; // parent directory portion
  basename: string; // filename only
  bitrate: number | undefined;
  duration: number | undefined;
  size: bigint;
  slotsFree: boolean;
}

export interface TrackMatch {
  track: MBTrack;
  file: FolderFile | undefined; // undefined = not found in folder
}

export interface FolderMatch {
  username: string;
  folder: string;
  coverageScore: number; // 0–1: fraction of tracks matched
  pathScore: number; // 0–1: artist+album in path
  files: TrackMatch[];
  allFiles: FolderFile[];
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Split a Soulseek filename into folder + basename.
 *  Soulseek uses backslash as separator. */
export function splitPath(filename: string): {
  folder: string;
  basename: string;
} {
  const parts = filename.replace(/\//g, "\\").split("\\");
  const basename = parts.pop() ?? filename;
  const folder = parts.join("\\");
  return { folder, basename };
}

/** Extract the last two path segments (Artist\Album or just Album). */
function pathTail(folder: string, segments = 2): string {
  const parts = folder.split("\\").filter(Boolean);
  return parts.slice(-segments).join(" ").toLowerCase();
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreFolder(folder: string, artist: string, album: string): number {
  const tail = pathTail(folder, 3);
  const artistNorm = normalize(artist);
  const albumNorm = normalize(album);

  // Check if artist and album names appear in the path tail
  const artistSim = similarity(
    artistNorm,
    tail.slice(0, artistNorm.length + 5),
  );
  const albumSim = similarity(albumNorm, tail.slice(-albumNorm.length - 5));

  // Also check if path simply contains both words
  const artistContained = tail.includes(artistNorm.split(" ")[0] ?? "");
  const albumContained = tail.includes(albumNorm.split(" ")[0] ?? "");

  const containBonus = (artistContained ? 0.3 : 0) + (albumContained ? 0.3 : 0);
  return Math.min(1, (artistSim + albumSim) / 2 + containBonus);
}

function scoreFileForTrack(file: FolderFile, track: MBTrack): number {
  const base = normalize(file.basename);
  const title = normalize(track.title);

  // Similarity of track title against filename
  const sim = similarity(title, base);

  // Bonus if track number appears in filename
  const numStr = String(track.position).padStart(2, "0");
  const hasNum =
    file.basename.includes(numStr) ||
    file.basename.startsWith(String(track.position));

  // Duration match bonus (±5 seconds)
  let durBonus = 0;
  if (track.duration && file.duration) {
    const diff = Math.abs(Math.round(track.duration / 1000) - file.duration);
    if (diff <= 5) durBonus = 0.2;
    else if (diff <= 15) durBonus = 0.1;
  }

  return sim * 0.6 + (hasNum ? 0.2 : 0) + durBonus;
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

/** Build FolderFile entries grouped by (username, folder). */
export function groupByFolder(
  results: FileSearchResponse[],
): Map<string, FolderFile[]> {
  const map = new Map<string, FolderFile[]>();

  for (const result of results) {
    for (const file of result.files) {
      const { folder, basename } = splitPath(file.filename);
      const key = `${result.username}\x00${folder}`;

      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({
        username: result.username,
        filename: file.filename,
        folder,
        basename,
        bitrate: file.attrs.get(FileAttribute.Bitrate),
        duration: file.attrs.get(FileAttribute.Duration),
        size: file.size,
        slotsFree: result.slotsFree,
      });
    }
  }

  return map;
}

/**
 * Find the best folder match for an album tracklist.
 *
 * Returns ranked list of folder matches, best first.
 * When settings are provided, only files passing format+bitrate filters are
 * considered for track matching. If no folder passes with filters, retries
 * without filters and marks the match as relaxed.
 */
export function findFolderMatches(
  results: FileSearchResponse[],
  tracks: MBTrack[],
  artist: string,
  album: string,
  minCoverage = 0.5,
  settings?: Settings,
): FolderMatch[] {
  const folders = groupByFolder(results);

  const buildMatches = (useFilters: boolean): FolderMatch[] => {
    const matches: FolderMatch[] = [];

    for (const [key, allFiles] of folders) {
      const [username, folder] = key.split("\x00") as [string, string];

      // Apply settings filter to candidate files for this folder
      const files =
        useFilters && settings
          ? allFiles.filter((f) =>
              passesFilters(f.filename, f.bitrate, settings),
            )
          : allFiles;

      // Skip tiny folders (likely not album folders)
      if (files.length < Math.min(3, tracks.length * 0.4)) continue;

      const pathScore = scoreFolder(folder, artist, album);

      // Match each track to the best file in this folder
      const trackMatches: TrackMatch[] = tracks.map((track) => {
        const scored = files
          .map((f) => ({ f, score: scoreFileForTrack(f, track) }))
          .sort((a, b) => b.score - a.score);

        const best = scored[0];
        const file = best && best.score >= 0.35 ? best.f : undefined;
        return { track, file };
      });

      const matched = trackMatches.filter((t) => t.file !== undefined).length;
      const coverageScore = matched / tracks.length;

      if (coverageScore < minCoverage) continue;

      matches.push({
        username,
        folder,
        coverageScore,
        pathScore,
        files: trackMatches,
        allFiles: files,
      });
    }

    matches.sort((a, b) => {
      const covDiff = b.coverageScore - a.coverageScore;
      if (Math.abs(covDiff) > 0.1) return covDiff;
      return b.pathScore - a.pathScore;
    });

    return matches;
  };

  // Try with filters first; fall back to unfiltered if nothing passes
  const filtered = buildMatches(true);
  if (filtered.length > 0) return filtered;
  return buildMatches(false);
}
