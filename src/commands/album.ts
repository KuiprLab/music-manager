import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { ItemStatus, ItemStatusColor } from "../types/item.js";
import { getSettings } from "../utils/settings.js";

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

// ─── Pending store ────────────────────────────────────────────────────────────

interface PendingAlbum {
  album: MBAlbum;
  trackStates: TrackState[];
  folderMatch: FolderMatch;
}

const pendingAlbums = new Map<string, PendingAlbum>();

export function getPendingAlbum(storeKey: string): PendingAlbum | undefined {
  return pendingAlbums.get(storeKey);
}

// ─── Embed ────────────────────────────────────────────────────────────────────

export function buildAlbumEmbed(
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

export function buildAlbumActionRow(
  storeKey: string,
  enabled: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`album:confirm:${storeKey}`)
      .setLabel("Download Album")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!enabled),
    new ButtonBuilder()
      .setCustomId(`album:cancel:${storeKey}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!enabled),
  );
}

// ─── Download + verify (exported for button handler) ─────────────────────────

export async function runAlbumDownload(
  pending: PendingAlbum,
  editReply: (opts: {
    embeds: EmbedBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  }) => Promise<unknown>,
): Promise<void> {
  const { album, trackStates, folderMatch } = pending;

  const destDir = path.join(
    process.env.DOWNLOAD_DIR ?? "./downloads",
    album.artist,
    album.title,
  );
  fs.mkdirSync(destDir, { recursive: true });

  const toDownload = folderMatch.files.filter((tm) => tm.file !== undefined);

  let lastUpdate = Date.now();
  const THROTTLE_MS = 3_000;

  const maybeUpdate = async (msg?: string): Promise<void> => {
    if (Date.now() - lastUpdate >= THROTTLE_MS) {
      lastUpdate = Date.now();
      await editReply({
        embeds: [
          buildAlbumEmbed(album, trackStates, ItemStatus.Downloading, msg),
        ],
      });
    }
  };

  // ── Download loop ─────────────────────────────────────────────────────────
  for (const tm of toDownload) {
    if (!tm.file) continue;
    const state = trackStates.find(
      (t) => t.track.position === tm.track.position,
    );
    if (!state) continue;

    state.status = "downloading";
    await maybeUpdate(`Track ${tm.track.position}/${album.trackCount}`);

    const basename =
      tm.file.filename.replace(/\\/g, "/").split("/").pop() ?? tm.file.filename;
    const tmpDir = path.join(destDir, ".tmp");
    const tmpPath = path.join(tmpDir, `${Date.now()}_${basename}`);
    const outPath = path.join(destDir, basename);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const client = await getSlskClient();
      const download = await client.download(
        tm.file.username,
        tm.file.filename,
      );

      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        download.stream.pipe(out);
        download.stream.on("error", reject);
        out.on("error", reject);
        download.events.on("complete", () => resolve());
        download.stream.on("end", () => resolve());
      });

      fs.renameSync(tmpPath, outPath);
      state.status = "done";
      console.log(`[album] ✓ ${tm.track.position}. ${tm.track.title}`);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      state.status = "failed";
      state.error = String(err).slice(0, 50);
      console.error(`[album] ✗ ${tm.track.position}. ${tm.track.title}:`, err);
    }

    await maybeUpdate(`Track ${tm.track.position}/${album.trackCount}`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log(`[album] verifying files in ${destDir}`);
  for (const tm of toDownload) {
    if (!tm.file) continue;
    const state = trackStates.find(
      (t) => t.track.position === tm.track.position,
    );
    if (!state || state.status !== "done") continue;

    const basename =
      tm.file.filename.replace(/\\/g, "/").split("/").pop() ?? tm.file.filename;
    const outPath = path.join(destDir, basename);

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      console.warn(`[album] ✗ verify failed: ${basename}`);
      state.status = "failed";
      state.error = "file missing after download";
    } else {
      console.log(
        `[album] ✓ verified: ${basename} (${fs.statSync(outPath).size} bytes)`,
      );
    }
  }

  // ── Final embed ───────────────────────────────────────────────────────────
  const done = trackStates.filter((t) => t.status === "done").length;
  const failed = trackStates.filter((t) => t.status === "failed").length;
  const missing = trackStates.filter((t) => t.status === "missing").length;

  const finalStatus =
    done === album.trackCount
      ? `All ${done} tracks verified and downloaded`
      : `${done} verified · ${failed} failed · ${missing} not found`;

  const finalItemStatus =
    done === album.trackCount ? ItemStatus.Done : ItemStatus.Failed;

  await editReply({
    embeds: [buildAlbumEmbed(album, trackStates, finalItemStatus, finalStatus)],
    components: [],
  });
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
    status: "pending" as TrackStatus,
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
  const settings = getSettings();
  const folderMatches = findFolderMatches(
    rawResults,
    album.tracks,
    album.artist,
    album.title,
    0.5,
    settings,
  );
  const best = folderMatches[0];

  console.log(`[album] ${folderMatches.length} folder matches`);
  if (best) {
    console.log(
      `[album] best: "${best.username}" → "${best.folder}" (${(best.coverageScore * 100).toFixed(0)}% coverage)`,
    );
  }

  if (!best) {
    for (const t of trackStates) t.status = "missing";
    await interaction.editReply({
      embeds: [
        buildAlbumEmbed(
          album,
          trackStates,
          ItemStatus.Failed,
          "No folder match found on Soulseek",
        ),
      ],
    });
    return;
  }

  // Mark tracks that won't be found
  for (const tm of best.files) {
    if (!tm.file) {
      const state = trackStates.find(
        (t) => t.track.position === tm.track.position,
      );
      if (state) state.status = "missing";
    }
  }

  // ── 4. Show confirm prompt ────────────────────────────────────────────────
  const storeKey = interaction.id;
  pendingAlbums.set(storeKey, { album, trackStates, folderMatch: best });
  setTimeout(() => pendingAlbums.delete(storeKey), 15 * 60 * 1000);

  const available = best.files.filter((tm) => tm.file !== undefined).length;
  const coverageMsg = `Found \`${best.username}\` — ${available}/${album.trackCount} tracks available`;

  await interaction.editReply({
    embeds: [
      buildAlbumEmbed(album, trackStates, ItemStatus.Ready, coverageMsg),
    ],
    components: [buildAlbumActionRow(storeKey, true)],
  });
}
