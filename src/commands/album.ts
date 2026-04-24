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
import { findFolderMatches } from "../utils/albumMatcher.js";
import { ItemStatus, ItemStatusColor } from "../types/item.js";
import { formatDuration } from "./single.js";

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

const TRACK_ICON: Record<TrackStatus, string> = {
  pending: "⏳",
  downloading: "⬇️",
  done: "✅",
  failed: "❌",
  missing: "❓",
};

// ─── Embed ────────────────────────────────────────────────────────────────────

function buildAlbumEmbed(
  album: MBAlbum,
  tracks: TrackState[],
  status: ItemStatus,
  statusMessage?: string,
): EmbedBuilder {
  const done = tracks.filter((t) => t.status === "done").length;
  const failed = tracks.filter((t) => t.status === "failed").length;
  const missing = tracks.filter((t) => t.status === "missing").length;
  const total = tracks.length;

  const description = tracks
    .map((t) => {
      const icon = TRACK_ICON[t.status];
      const num = String(t.track.position).padStart(2, "0");
      const err = t.error ? ` *(${t.error})*` : "";
      return `${icon} \`${num}.\` ${t.track.title}${err}`;
    })
    .join("\n");

  const footerParts = [
    `${done}/${total} downloaded`,
    failed > 0 ? `${failed} failed` : null,
    missing > 0 ? `${missing} not found` : null,
    statusMessage,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(ItemStatusColor[status])
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

// ─── Download helper ──────────────────────────────────────────────────────────

async function downloadFile(
  username: string,
  filename: string,
  destDir: string,
): Promise<void> {
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
}

// ─── Command execute ──────────────────────────────────────────────────────────

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query = interaction.options.getString("query", true);
  await interaction.deferReply();

  // ── 1. MusicBrainz lookup ─────────────────────────────────────────────────
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(ItemStatusColor[ItemStatus.Searching])
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
          .setColor(ItemStatusColor[ItemStatus.Failed])
          .setTitle("Not Found")
          .setDescription(`Could not find **${query}** on MusicBrainz.`),
      ],
    });
    return;
  }

  console.log(
    `[album] "${album.artist} - ${album.title}" (${album.trackCount} tracks)`,
  );

  const trackStates: TrackState[] = album.tracks.map((t) => ({
    track: t,
    status: "pending",
  }));

  // ── 2. Soulseek search ────────────────────────────────────────────────────
  await interaction.editReply({
    embeds: [
      buildAlbumEmbed(
        album,
        trackStates,
        ItemStatus.Searching,
        "Searching Soulseek…",
      ),
    ],
  });

  const client = await getSlskClient();
  const rawResults = await client.search(album.slskQuery, { timeout: 12_000 });
  console.log(
    `[album] ${rawResults.length} peer responses for "${album.slskQuery}"`,
  );

  if (rawResults.length === 0) {
    for (const t of trackStates) t.status = "missing";
    await interaction.editReply({
      embeds: [
        buildAlbumEmbed(
          album,
          trackStates,
          ItemStatus.Failed,
          "No results on Soulseek",
        ),
      ],
    });
    return;
  }

  // ── 3. Folder matching ────────────────────────────────────────────────────
  const folderMatches = findFolderMatches(
    rawResults,
    album.tracks,
    album.artist,
    album.title,
  );
  const best = folderMatches[0];

  console.log(`[album] ${folderMatches.length} folder matches`);
  if (best) {
    console.log(
      `[album] best: "${best.username}" → "${best.folder}" (${(best.coverageScore * 100).toFixed(0)}% coverage)`,
    );
  }

  // Mark missing tracks
  if (best) {
    for (const tm of best.files) {
      if (!tm.file) {
        const state = trackStates.find(
          (t) => t.track.position === tm.track.position,
        );
        if (state) state.status = "missing";
      }
    }
  } else {
    for (const t of trackStates) t.status = "missing";
  }

  const sourceLabel = best
    ? `Downloading from \`${best.username}\`…`
    : "No folder match — cannot download";

  await interaction.editReply({
    embeds: [
      buildAlbumEmbed(
        album,
        trackStates,
        best ? ItemStatus.Downloading : ItemStatus.Failed,
        sourceLabel,
      ),
    ],
  });

  if (!best) return;

  // ── 4. Download ───────────────────────────────────────────────────────────
  const destDir = path.join(
    process.env.DOWNLOAD_DIR ?? "./downloads",
    album.artist,
    album.title,
  );
  fs.mkdirSync(destDir, { recursive: true });

  const toDownload = best.files.filter((tm) => tm.file !== undefined);

  let lastUpdate = Date.now();
  const THROTTLE_MS = 3_000;

  const maybeUpdate = async (msg?: string): Promise<void> => {
    if (Date.now() - lastUpdate >= THROTTLE_MS) {
      lastUpdate = Date.now();
      await interaction.editReply({
        embeds: [
          buildAlbumEmbed(album!, trackStates, ItemStatus.Downloading, msg),
        ],
      });
    }
  };

  for (const tm of toDownload) {
    if (!tm.file) continue;

    const state = trackStates.find(
      (t) => t.track.position === tm.track.position,
    );
    if (!state) continue;

    state.status = "downloading";
    await maybeUpdate(`Track ${tm.track.position}/${album.trackCount}`);

    try {
      await downloadFile(tm.file.username, tm.file.filename, destDir);
      state.status = "done";
      console.log(`[album] ✓ ${tm.track.position}. ${tm.track.title}`);
    } catch (err) {
      state.status = "failed";
      state.error = String(err).slice(0, 50);
      console.error(`[album] ✗ ${tm.track.position}. ${tm.track.title}:`, err);
    }

    await maybeUpdate(`Track ${tm.track.position}/${album.trackCount}`);
  }

  // ── 5. Final embed ────────────────────────────────────────────────────────
  const done = trackStates.filter((t) => t.status === "done").length;
  const failed = trackStates.filter((t) => t.status === "failed").length;
  const missing = trackStates.filter((t) => t.status === "missing").length;

  const finalStatus =
    done === album.trackCount
      ? `All ${done} tracks downloaded`
      : `${done} done · ${failed} failed · ${missing} not found`;

  const finalItemStatus =
    done === album.trackCount
      ? ItemStatus.Done
      : done > 0
        ? ItemStatus.Done
        : ItemStatus.Failed;

  await interaction.editReply({
    embeds: [buildAlbumEmbed(album, trackStates, finalItemStatus, finalStatus)],
  });
}
