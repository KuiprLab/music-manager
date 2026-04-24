import { MusicBrainzApi, CoverArtArchiveApi } from "musicbrainz-api";
import type { IRecordingMatch, IRelease, IReleaseGroup } from "musicbrainz-api";

// ─── Clients (singletons) ─────────────────────────────────────────────────────

const mbApi = new MusicBrainzApi({
  appName: "music-manager",
  appVersion: "1.0.0",
  appContactInfo: "music-manager-discord-bot",
});

const caaApi = new CoverArtArchiveApi();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MBRecording {
  id: string;
  title: string;
  artist: string;
  album: string | undefined;
  releaseId: string | undefined;
  releaseGroupId: string | undefined;
  date: string | undefined;
  duration: number | undefined;
  score: number;
}

export interface MBMatch {
  recording: MBRecording;
  coverUrl: string | undefined;
  slskQuery: string;
}

// ─── Album types ──────────────────────────────────────────────────────────────

export interface MBTrack {
  position: number; // 1-based track number
  title: string;
  duration: number | undefined; // ms
}

export interface MBAlbum {
  releaseId: string;
  title: string;
  artist: string;
  date: string | undefined;
  trackCount: number;
  tracks: MBTrack[];
  coverUrl: string | undefined;
  /** Canonical Soulseek search string: "Artist - Album" */
  slskQuery: string;
}

// ─── Release scoring ──────────────────────────────────────────────────────────

const RELEASE_TYPE_SCORE: Record<string, number> = {
  Single: 1.0,
  Album: 0.95,
  EP: 0.8,
  Broadcast: 0.4,
  Other: 0.3,
};

const BAD_SECONDARY_TYPES = new Set([
  "Live",
  "Compilation",
  "Remix",
  "Bootleg",
  "Demo",
]);

function scoreRelease(release: IRelease): number {
  const rg = release["release-group"];
  if (!rg) return 0.3;

  const secondaryTypes: string[] = rg["secondary-types"] ?? [];
  if (secondaryTypes.some((t) => BAD_SECONDARY_TYPES.has(t))) return -1;

  const primaryScore = RELEASE_TYPE_SCORE[rg["primary-type"] ?? ""] ?? 0.3;
  const hasDate = release.date ? 0.05 : 0;
  return primaryScore + hasDate;
}

function bestRelease(releases: IRelease[] | undefined): IRelease | undefined {
  if (!releases || releases.length === 0) return undefined;
  return releases.slice().sort((a, b) => scoreRelease(b) - scoreRelease(a))[0];
}

// ─── Title penalty ────────────────────────────────────────────────────────────

const BAD_TITLE_RE =
  /\b(remix|remixed|re-mix|live|acoustic|instrumental|karaoke|cover|edit|reprise|demo|dub|bootleg)\b/i;

function isBadTitle(title: string): boolean {
  return BAD_TITLE_RE.test(title);
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

function rankRecordings(
  matches: IRecordingMatch[],
  luceneQuery: string,
): MBRecording | undefined {
  if (matches.length === 0) {
    console.log(`[mb] "${luceneQuery}" → 0 results`);
    return undefined;
  }

  const scored = matches.map((r) => {
    const release = bestRelease(r.releases);
    const relScore = release ? scoreRelease(release) : 0.3;
    const titlePenalty = isBadTitle(r.title) ? -1 : 0;
    const combined = (r.score / 100) * 0.7 + relScore * 0.3 + titlePenalty;

    const artistCredit = r["artist-credit"];
    const artist = Array.isArray(artistCredit)
      ? artistCredit
          .map((c) =>
            typeof c === "string" ? c : (c.name ?? c.artist?.name ?? ""),
          )
          .join("")
      : "Unknown Artist";

    const recording: MBRecording = {
      id: r.id,
      title: r.title,
      artist: artist || "Unknown Artist",
      album: release?.title,
      releaseId: release?.id,
      releaseGroupId: release?.["release-group"]?.id,
      date: release?.date,
      duration: r.length,
      score: r.score,
    };

    const rg = release?.["release-group"];
    console.log(
      `[mb]   ${r.score}% combined=${combined.toFixed(2)} title="${r.title}" artist="${artist}" ` +
        `release="${release?.title ?? "-"}" type=${rg?.["primary-type"] ?? "-"}` +
        (rg?.["secondary-types"]?.length
          ? `+${rg["secondary-types"].join("+")}`
          : "") +
        (titlePenalty ? " [BAD TITLE]" : ""),
    );

    return { recording, combined };
  });

  scored.sort((a, b) => b.combined - a.combined);
  const winner = scored[0]!.recording;
  console.log(
    `[mb] "${luceneQuery}" → winner: "${winner.artist} - ${winner.title}" (${winner.album ?? "no album"})`,
  );
  return winner;
}

// ─── Cover art ────────────────────────────────────────────────────────────────

async function getCoverUrl(releaseId: string): Promise<string | undefined> {
  try {
    const covers = await caaApi.getReleaseCovers(releaseId);
    const front = covers.images.find((i) => i.front) ?? covers.images[0];
    if (!front) {
      console.log(`[mb] cover art: no images for release ${releaseId}`);
      return undefined;
    }
    const thumbs = front.thumbnails as Record<string, string>;
    const url = thumbs["500"] ?? thumbs["large"] ?? front.image;
    console.log(`[mb] cover art: ${url}`);
    return url;
  } catch (err) {
    console.log(`[mb] cover art fetch failed for ${releaseId}: ${String(err)}`);
    return undefined;
  }
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Parse a query into artist + title.
 * Explicit: "Artist - Title" or "Artist: Title"
 * Heuristic: treat first word(s) as artist when query has multiple words
 *   e.g. "Taylor Swift Shake It Off" → artist="Taylor Swift", title="Shake It Off"
 *   We try all possible split points and return all candidates.
 */
function parseQuery(query: string): { artist: string; title: string }[] {
  const results: { artist: string; title: string }[] = [];

  // Explicit separator — highest confidence, return only this
  const sep = query.match(/^(.+?)\s*[-:]\s*(.+)$/);
  if (sep) {
    return [{ artist: sep[1]!.trim(), title: sep[2]!.trim() }];
  }

  // Heuristic: try every split point in both directions
  // "Taylor Swift Shake It Off" → artist=first N, title=rest
  // "Shake It Off Taylor Swift" → artist=last N, title=first part
  const words = query.trim().split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    // artist-first: "Taylor Swift | Shake It Off"
    results.push({
      artist: words.slice(0, i).join(" "),
      title: words.slice(i).join(" "),
    });
    // artist-last: "Shake It Off | Taylor Swift"
    results.push({
      artist: words.slice(i).join(" "),
      title: words.slice(0, i).join(" "),
    });
  }

  // Deduplicate (both directions produce the same pair at the midpoint)
  const seen = new Set<string>();
  return results.filter(({ artist, title }) => {
    const key = `${artist}|||${title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type SearchAttempt = { label: string; q: string; dismax?: boolean };

async function runSearch(attempt: SearchAttempt): Promise<IRecordingMatch[]> {
  console.log(`[mb] trying: ${attempt.label}`);
  try {
    const result = await mbApi.search("recording", {
      query: attempt.q,
      ...(attempt.dismax ? { dismax: "true" as unknown as boolean } : {}),
    });
    const list = result as unknown as { recordings: IRecordingMatch[] };
    return list.recordings ?? [];
  } catch (err) {
    console.error(`[mb] search error (${attempt.label}):`, err);
    return [];
  }
}

export async function resolveMusicBrainz(
  query: string,
): Promise<MBMatch | undefined> {
  console.log(`[mb] resolving: "${query}"`);
  const splits = parseQuery(query);

  // Build attempts in priority order
  const attempts: SearchAttempt[] = [];

  // 1. Structured field queries for each split point (highest precision)
  //    Uses MB's native artist + recording field matching — same approach as beets
  for (const { artist, title } of splits) {
    attempts.push({
      label: `artist:"${artist}" recording:"${title}"`,
      q: `artist:"${artist}" AND recording:"${title}"`,
    });
  }

  // 2. Loosen artist to token match for each split
  for (const { artist, title } of splits) {
    attempts.push({
      label: `artist:(${artist}) recording:"${title}"`,
      q: `artist:(${artist}) AND recording:"${title}"`,
    });
  }

  // 3. Title phrase only (catches queries that are just a song title)
  attempts.push({
    label: `recording:"${query}"`,
    q: `recording:"${query}"`,
  });

  // 4. Dismax fallback — broad recall, lowest precision
  attempts.push({
    label: `dismax: "${query}"`,
    q: query,
    dismax: true,
  });

  let best: MBRecording | undefined;

  for (const attempt of attempts) {
    const raws = await runSearch(attempt);
    best = rankRecordings(raws, attempt.label);
    if (best) break;
  }

  if (!best) {
    console.log(`[mb] no usable result found for "${query}"`);
    return undefined;
  }

  const coverUrl = best.releaseId
    ? await getCoverUrl(best.releaseId)
    : undefined;
  const slskQuery = `${best.artist} - ${best.title}`;
  console.log(`[mb] slsk query: "${slskQuery}"`);

  return { recording: best, coverUrl, slskQuery };
}

// ─── Album resolver ───────────────────────────────────────────────────────────

interface IReleaseWithMedia {
  id: string;
  title: string;
  date?: string;
  media?: {
    position: number;
    tracks?: {
      position: number;
      title: string;
      length?: number;
      recording?: { length?: number };
    }[];
  }[];
  "artist-credit"?: { name?: string; artist: { name: string } }[];
  "release-group"?: {
    id?: string;
    "primary-type"?: string;
    "secondary-types"?: string[];
  };
}

type ReleaseGroupMatch = IReleaseGroup & {
  score: number;
  "primary-type"?: string;
  "secondary-types"?: string[];
  "artist-credit"?: { name?: string; artist: { name: string } }[];
  "first-release-date"?: string;
};

async function searchReleaseGroups(
  luceneQuery: string,
  dismax = false,
): Promise<ReleaseGroupMatch[]> {
  console.log(
    `[mb:album] trying: "${luceneQuery}"${dismax ? " (dismax)" : ""}`,
  );
  try {
    const res = await mbApi.search("release-group", {
      query: luceneQuery,
      ...(dismax ? { dismax: "true" as unknown as boolean } : {}),
    } as Parameters<typeof mbApi.search>[1]);

    const list = res as unknown as { "release-groups": ReleaseGroupMatch[] };
    return list["release-groups"] ?? [];
  } catch (err) {
    console.error(`[mb:album] search error for "${luceneQuery}":`, err);
    return [];
  }
}

function filterReleaseGroups(groups: ReleaseGroupMatch[]): ReleaseGroupMatch[] {
  return groups
    .filter(
      (rg) =>
        !(rg["secondary-types"] ?? []).some((t) => BAD_SECONDARY_TYPES.has(t)),
    )
    .filter((rg) =>
      ["Album", "Single", "EP", ""].includes(rg["primary-type"] ?? ""),
    );
}

/**
 * Search for an album by query string.
 * Uses the same multi-split Lucene approach as resolveMusicBrainz.
 */
export async function resolveAlbum(
  query: string,
): Promise<MBAlbum | undefined> {
  console.log(`[mb:album] resolving: "${query}"`);

  const splits = parseQuery(query);

  // Build attempts: structured queries first, dismax last
  type Attempt = { q: string; dismax?: boolean };
  const attempts: Attempt[] = [];

  for (const { artist, title } of splits) {
    attempts.push({ q: `artistname:"${artist}" AND releasegroup:"${title}"` });
  }
  for (const { artist, title } of splits) {
    attempts.push({ q: `artistname:(${artist}) AND releasegroup:"${title}"` });
  }
  attempts.push({ q: `releasegroup:"${query}"` });
  attempts.push({ q: query, dismax: true });

  let topGroup: ReleaseGroupMatch | undefined;

  for (const attempt of attempts) {
    const all = await searchReleaseGroups(attempt.q, attempt.dismax);
    const filtered = filterReleaseGroups(all);
    if (filtered.length > 0) {
      topGroup = filtered[0];
      break;
    }
  }

  if (!topGroup) {
    console.log(`[mb:album] no release groups found`);
    return undefined;
  }

  const artist =
    topGroup["artist-credit"]
      ?.map((c) => c.name ?? c.artist.name)
      .join(" & ") ?? "Unknown Artist";

  console.log(
    `[mb:album] top group: "${artist} - ${topGroup.title}" (score ${topGroup.score})`,
  );

  // Find best individual release in this group: prefer studio, earliest date
  const releaseRes = await (mbApi as any).browse(
    "release",
    { "release-group": topGroup.id },
    ["recordings"],
  );

  const releases =
    (releaseRes as unknown as { releases: IReleaseWithMedia[] }).releases ?? [];

  const scored = releases
    .map((r) => {
      const rg = r["release-group"];
      const sec: string[] = rg?.["secondary-types"] ?? [];
      if (sec.some((t) => BAD_SECONDARY_TYPES.has(t))) return null;
      const dateScore = r.date ? 1 - parseInt(r.date.slice(0, 4)) / 3000 : 0.5;
      return { release: r, score: dateScore };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  const bestRelease = scored[0]?.release ?? releases[0];
  if (!bestRelease) {
    console.log(`[mb:album] no releases found in group`);
    return undefined;
  }

  // Flatten all tracks across all media
  const tracks: MBTrack[] = [];
  let globalPos = 1;
  for (const medium of bestRelease.media ?? []) {
    for (const track of medium.tracks ?? []) {
      tracks.push({
        position: globalPos++,
        title: track.title,
        duration: track.length ?? track.recording?.length,
      });
    }
  }

  if (tracks.length === 0) {
    console.log(`[mb:album] release has no tracks`);
    return undefined;
  }

  console.log(
    `[mb:album] "${artist} - ${topGroup.title}" — ${tracks.length} tracks`,
  );

  const coverUrl = await getCoverUrl(bestRelease.id);

  return {
    releaseId: bestRelease.id,
    title: topGroup.title,
    artist,
    date: bestRelease.date ?? topGroup["first-release-date"],
    trackCount: tracks.length,
    tracks,
    coverUrl,
    slskQuery: `${artist} ${topGroup.title}`,
  };
}
