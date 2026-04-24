import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { getSlskClient } from "../utils/slskManager.js";
import type { FileSearchResponse } from "../soulseek-ts/messages/from/peer.js";
import { FileAttribute } from "../soulseek-ts/messages/common.js";
import { scoreFile } from "../utils/rank.js";
import { resolveMusicBrainz } from "../utils/musicbrainz.js";
import { getSettings, passesFilters } from "../utils/settings.js";

export const data = new SlashCommandBuilder()
  .setName("search")
  .setDescription("Search for music on Soulseek")
  .addStringOption((opt) =>
    opt
      .setName("query")
      .setDescription("Artist, album or track name")
      .setRequired(true),
  );

// ─── Pending state ────────────────────────────────────────────────────────────

export interface PendingEntry {
  result: FileSearchResponse;
  fileIndex: number;
}

const pendingResults = new Map<string, PendingEntry[]>();

export function getPendingResult(
  storeKey: string,
  index: number,
): PendingEntry | undefined {
  return pendingResults.get(storeKey)?.[index];
}

export function getPendingResults(
  storeKey: string,
): PendingEntry[] | undefined {
  return pendingResults.get(storeKey);
}

// ─── Embed builders (exported so interactionCreate can reuse them) ─────────────

export function buildMbEmbed(
  rec: Awaited<ReturnType<typeof resolveMusicBrainz>> extends undefined
    ? never
    : NonNullable<Awaited<ReturnType<typeof resolveMusicBrainz>>>["recording"],
  coverUrl: string | undefined,
  status: "searching" | "ready" | "downloading" | "done",
  statusText?: string,
): EmbedBuilder {
  const duration = rec.duration
    ? formatDuration(Math.round(rec.duration / 1000))
    : undefined;

  const colors: Record<typeof status, number> = {
    searching: 0x5865f2,
    ready: 0x57f287,
    downloading: 0xfee75c,
    done: 0x57f287,
  };

  const embed = new EmbedBuilder()
    .setColor(colors[status])
    .setTitle(rec.title)
    .setAuthor({ name: rec.artist })
    .setFooter({
      text: [rec.album, rec.date?.slice(0, 4), duration, statusText]
        .filter(Boolean)
        .join(" · "),
    });

  if (coverUrl) embed.setThumbnail(coverUrl);
  return embed;
}

export function buildSelectComponents(
  storeKey: string,
  entries: PendingEntry[],
): [
  ActionRowBuilder<StringSelectMenuBuilder>,
  ActionRowBuilder<ButtonBuilder>,
] {
  const options = entries.slice(0, 25).map((entry, i) => {
    const file = entry.result.files[entry.fileIndex]!;
    const name = (file.filename.split(/[\\/]/).pop() ?? file.filename).slice(
      0,
      100,
    );
    const bitrate = file.attrs.get(FileAttribute.Bitrate);
    const duration = file.attrs.get(FileAttribute.Duration);
    const bitrateStr = bitrate ? `${bitrate}kbps` : "?kbps";
    const durStr = duration ? formatDuration(duration) : "?:??";
    const slot = entry.result.slotsFree ? "✓ slot free" : "· queued";

    return new StringSelectMenuOptionBuilder()
      .setValue(`${i}`)
      .setLabel(name)
      .setDescription(`${bitrateStr} · ${durStr} · ${slot}`.slice(0, 100));
  });

  const selectRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`search:file:${storeKey}`)
        .setPlaceholder("Choose a file to download…")
        .addOptions(options),
    );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`search:back:${storeKey}`)
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
  );

  return [selectRow, backRow];
}

// ─── Action rows ──────────────────────────────────────────────────────────────

export function buildMainRow(
  storeKey: string,
  ready: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`search:download:${storeKey}`)
      .setLabel(ready ? "Download" : "Preparing…")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!ready),
    new ButtonBuilder()
      .setCustomId(`search:select:${storeKey}`)
      .setLabel("Select File…")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!ready),
  );
}

// ─── Command execute ──────────────────────────────────────────────────────────

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query = interaction.options.getString("query", true);

  await interaction.deferReply();

  // 1. MusicBrainz lookup
  let slskQuery = query;
  let mbRec: Parameters<typeof buildMbEmbed>[0] | undefined;
  let coverUrl: string | undefined;

  try {
    const match = await resolveMusicBrainz(query);
    if (match) {
      slskQuery = match.slskQuery;
      mbRec = match.recording;
      coverUrl = match.coverUrl;
    }
  } catch (err) {
    console.error("[musicbrainz] lookup failed:", err);
  }

  const storeKey = interaction.id;

  // Show embed immediately with disabled buttons
  const initialEmbed = mbRec
    ? buildMbEmbed(mbRec, coverUrl, "searching", "Searching Soulseek…")
    : new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(query)
        .setDescription("Searching Soulseek…");

  await interaction.editReply({
    embeds: [initialEmbed],
    components: [buildMainRow(storeKey, false)],
  });

  // 2. Soulseek search
  let client;
  try {
    client = await getSlskClient();
  } catch (err) {
    await interaction.editReply({
      content: `Failed to connect to Soulseek: ${String(err)}`,
      embeds: [],
      components: [],
    });
    return;
  }

  const settings = getSettings();
  const rawResults = await client.search(slskQuery, { timeout: 10_000 });

  if (rawResults.length === 0) {
    const embed = mbRec
      ? buildMbEmbed(
          mbRec,
          coverUrl,
          "searching",
          "No results found on Soulseek",
        )
      : new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(query)
          .setDescription("No results found.");
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  const rankAll = (useFilters: boolean) =>
    rawResults
      .flatMap((r) =>
        r.files.map((f, fi) => {
          const bitrate = f.attrs.get(FileAttribute.Bitrate);
          if (useFilters && !passesFilters(f.filename, bitrate, settings))
            return null;
          const scored = scoreFile(
            query,
            f.filename,
            r.slotsFree,
            bitrate,
            settings,
          );
          return { result: r, fileIndex: fi, file: f, ...scored };
        }),
      )
      .filter(
        (x): x is NonNullable<typeof x> => x !== null && x.coverage >= 0.5,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 9);

  let flat = rankAll(true);
  if (flat.length === 0) flat = rankAll(false);

  if (flat.length === 0) {
    const embed = mbRec
      ? buildMbEmbed(mbRec, coverUrl, "searching", "No matching files found")
      : new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(query)
          .setDescription("No matching files found.");
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  // Store results
  pendingResults.set(
    storeKey,
    flat.map(({ result, fileIndex }) => ({ result, fileIndex })),
  );
  setTimeout(() => pendingResults.delete(storeKey), 15 * 60 * 1000);

  // Update embed + enable buttons
  const readyEmbed = mbRec
    ? buildMbEmbed(mbRec, coverUrl, "ready", `${rawResults.length} peers found`)
    : new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(query)
        .setDescription(`${rawResults.length} peers found`);

  await interaction.editReply({
    embeds: [readyEmbed],
    components: [buildMainRow(storeKey, true)],
  });

  // Stash for interactionCreate
  (interaction.client as any).__mbCache ??= new Map();
  (interaction.client as any).__mbCache.set(storeKey, { rec: mbRec, coverUrl });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
