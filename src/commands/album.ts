import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSlskClient } from "../utils/slskManager.js";
import {
  resolveAlbum,
  type MBAlbum,
  type MBTrack,
} from "../utils/musicbrainz.js";
import { findFolderMatches, type FolderMatch } from "../utils/albumMatcher.js";

export const data = new SlashCommandBuilder()
  .setName("album")
  .setDescription("Download a full album from Soulseek")
  .addStringOption((opt) =>
    opt
      .setName("query")
      .setDescription("Artist and album name")
      .setRequired(true),
  );

// ─── Track status ─────────────────────────────────────────────────────────────

type TrackStatus = "pending" | "downloading" | "done" | "failed" | "missing";

interface TrackState {
  track: MBTrack;
  status: TrackStatus;
  error?: string;
}

// ─── Embed builder ────────────────────────────────────────────────────────────

const STATUS_ICON: Record<TrackStatus, string> = {
  pending: "⏳",
  downloading: "⬇️",
  done: "✅",
  failed: "❌",
  missing: "❓",
};

function buildAlbumEmbed(
  album: MBAlbum,
  tracks: TrackState[],
  statusLine?: string,
): EmbedBuilder {
  const done = tracks.filter((t) => t.status === "done").length;
  const failed = tracks.filter((t) => t.status === "failed").length;
  const missing = tracks.filter((t) => t.status === "missing").length;
  const total = tracks.length;

  const allDone = done + failed + missing === total;
  const color = allDone
    ? failed + missing > 0
      ? 0xfee75c
      : 0x57f287
    : 0x5865f2;

  const description = tracks
    .map((t) => {
      const icon = STATUS_ICON[t.status];
      const num = String(t.track.position).padStart(2, "0");
      const err = t.error ? ` *(${t.error})*` : "";
      return `${icon} \`${num}.\` ${t.track.title}${err}`;
    })
    .join("\n");

  const footerParts = [
    `${done}/${total} downloaded`,
    failed > 0 ? `${failed} failed` : null,
    missing > 0 ? `${missing} not found` : null,
    statusLine,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(album.title)
    .setAuthor({ name: album.artist })
    .setDescription(description)
    .setFooter({ text: footerParts.join(" · ") });

  if (album.coverUrl) embed.setThumbnail(album.coverUrl);
  if (album.date)
    embed.addFields({
      name: "Year",
      value: album.date.slice(0, 4),
      inline: true,
    });

  return embed;
}

// ─── Download a single file ───────────────────────────────────────────────────

async function downloadFile(
  username: string,
  filename: string,
  destDir: string,
): Promise<string> {
  const client = await getSlskClient();
  const download = await client.download(username, filename);

  const basename = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const tmpDir = path.join(destDir, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, `${Date.now()}_${basename}`);
  const outPath = path.join(destDir, basename);

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    download.stream.pipe(out);
    download.stream.on("error", reject);
    out.on("error", reject);
    download.events.on("complete", () => resolve());
    download.stream.on("end", () => resolve());
  });

  fs.renameSync(tmpPath, outPath);
  return outPath;
}

// ─── Command execute ──────────────────────────────────────────────────────────

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query = interaction.options.getString("query", true);
  await interaction.deferReply();

  // ── 1. MusicBrainz album lookup ───────────────────────────────────────────
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Looking up album…")
        .setDescription(`Searching MusicBrainz for **${query}**`),
    ],
  });

  let album: MBAlbum | undefined;
  try {
    album = await resolveAlbum(query);
  } catch (err) {
    console.error("[album] MB lookup failed:", err);
  }

  if (!album) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("Not Found")
          .setDescription(`Could not find album **${query}** on MusicBrainz.`),
      ],
    });
    return;
  }

  console.log(
    `[album] found: "${album.artist} - ${album.title}" (${album.trackCount} tracks)`,
  );

  // ── 2. Soulseek folder search ─────────────────────────────────────────────
  const trackStates: TrackState[] = album.tracks.map((t) => ({
    track: t,
    status: "pending",
  }));

  await interaction.editReply({
    embeds: [buildAlbumEmbed(album, trackStates, "Searching Soulseek…")],
  });

  const client = await getSlskClient();
  const slskQuery = album.slskQuery;
  console.log(`[album] searching slsk: "${slskQuery}"`);

  const rawResults = await client.search(slskQuery, { timeout: 12_000 });
  console.log(`[album] got ${rawResults.length} peer responses`);

  if (rawResults.length === 0) {
    for (const t of trackStates) t.status = "missing";
    await interaction.editReply({
      embeds: [buildAlbumEmbed(album, trackStates, "No results on Soulseek")],
    });
    return;
  }

  // ── 3. Find best folder match ─────────────────────────────────────────────
  const folderMatches = findFolderMatches(
    rawResults,
    album.tracks,
    album.artist,
    album.title,
  );
  console.log(`[album] found ${folderMatches.length} folder matches`);

  let folderMatch: FolderMatch | undefined = folderMatches[0];

  if (folderMatch) {
    console.log(
      `[album] best folder: "${folderMatch.username}" → "${folderMatch.folder}" (coverage ${(folderMatch.coverageScore * 100).toFixed(0)}%)`,
    );
  }

  // Mark missing tracks
  if (folderMatch) {
    for (const tm of folderMatch.files) {
      if (!tm.file) {
        trackStates.find(
          (t) => t.track.position === tm.track.position,
        )!.status = "missing";
      }
    }
  } else {
    for (const t of trackStates) t.status = "missing";
  }

  await interaction.editReply({
    embeds: [
      buildAlbumEmbed(
        album,
        trackStates,
        folderMatch
          ? `Downloading from ${folderMatch.username}…`
          : "No folder match found — trying individual tracks…",
      ),
    ],
  });

  // ── 4. Download ───────────────────────────────────────────────────────────
  const destDir = path.join(
    process.env.DOWNLOAD_DIR ?? "./downloads",
    album.artist,
    album.title,
  );
  fs.mkdirSync(destDir, { recursive: true });

  const filesToDownload = folderMatch
    ? folderMatch.files.filter((tm) => tm.file !== undefined)
    : [];

  // Update embed every N downloads to avoid rate limits
  let lastUpdate = Date.now();
  const UPDATE_INTERVAL_MS = 3000;

  const maybeUpdateEmbed = async (status?: string): Promise<void> => {
    if (Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
      lastUpdate = Date.now();
      await interaction.editReply({
        embeds: [buildAlbumEmbed(album!, trackStates, status)],
      });
    }
  };

  for (const tm of filesToDownload) {
    if (!tm.file) continue;

    const state = trackStates.find(
      (t) => t.track.position === tm.track.position,
    )!;
    state.status = "downloading";
    await maybeUpdateEmbed(
      `Downloading track ${tm.track.position}/${album.trackCount}…`,
    );

    try {
      await downloadFile(tm.file.username, tm.file.filename, destDir);
      state.status = "done";
      console.log(`[album] ✓ ${tm.track.position}. ${tm.track.title}`);
    } catch (err) {
      state.status = "failed";
      state.error = String(err).slice(0, 60);
      console.error(`[album] ✗ ${tm.track.position}. ${tm.track.title}:`, err);
    }

    await maybeUpdateEmbed(
      `Downloading track ${tm.track.position}/${album.trackCount}…`,
    );
  }

  // ── 5. Final embed ────────────────────────────────────────────────────────
  const done = trackStates.filter((t) => t.status === "done").length;
  const failed = trackStates.filter((t) => t.status === "failed").length;
  const missing = trackStates.filter((t) => t.status === "missing").length;

  const finalStatus =
    done === album.trackCount
      ? `All ${done} tracks downloaded → ${destDir}`
      : `${done} downloaded, ${failed} failed, ${missing} not found → ${destDir}`;

  await interaction.editReply({
    embeds: [buildAlbumEmbed(album, trackStates, finalStatus)],
  });
}
