import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { getSlskClient } from "../utils/slskManager.js";
import type { FileSearchResponse } from "../soulseek-ts/messages/from/peer.js";
import { FileAttribute } from "../soulseek-ts/messages/common.js";

export const data = new SlashCommandBuilder()
  .setName("search")
  .setDescription("Search for music on Soulseek")
  .addStringOption((opt) =>
    opt
      .setName("query")
      .setDescription("Artist, album or track name")
      .setRequired(true),
  );

interface PendingEntry {
  result: FileSearchResponse;
  fileIndex: number;
}

const pendingResults = new Map<string, PendingEntry[]>();

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query = interaction.options.getString("query", true);

  await interaction.deferReply();

  let client;
  try {
    client = await getSlskClient();
  } catch (err) {
    await interaction.editReply(
      `Failed to connect to Soulseek: ${String(err)}`,
    );
    return;
  }

  await interaction.editReply(`Searching for **${query}**…`);

  const rawResults = await client.search(query, { timeout: 10_000 });

  if (rawResults.length === 0) {
    await interaction.editReply(`No results found for **${query}**.`);
    return;
  }

  // Flatten to individual files, sort by quality
  const flat = rawResults
    .flatMap((r, _ri) =>
      r.files.map((f, fi) => ({ result: r, fileIndex: fi, file: f })),
    )
    .sort((a, b) => {
      if (a.result.slotsFree !== b.result.slotsFree)
        return a.result.slotsFree ? -1 : 1;
      const bitrateA = a.file.attrs.get(FileAttribute.Bitrate) ?? 0;
      const bitrateB = b.file.attrs.get(FileAttribute.Bitrate) ?? 0;
      return bitrateB - bitrateA;
    })
    .slice(0, 10);

  const storeKey = interaction.id;
  pendingResults.set(
    storeKey,
    flat.map(({ result, fileIndex }) => ({ result, fileIndex })),
  );
  setTimeout(() => pendingResults.delete(storeKey), 15 * 60 * 1000);

  const embed = new EmbedBuilder()
    .setTitle(`Results for "${query}"`)
    .setColor(0x5865f2)
    .setDescription(
      flat
        .map(({ result, file }, i) => {
          const name = file.filename.split(/[\\/]/).pop() ?? file.filename;
          const bitrate = file.attrs.get(FileAttribute.Bitrate);
          const duration = file.attrs.get(FileAttribute.Duration);
          const bitrateStr = bitrate ? `${bitrate}kbps` : "?kbps";
          const durStr = duration ? formatDuration(duration) : "?:??";
          const slot = result.slotsFree ? "✓" : "·";
          return `\`${i + 1}.\` ${slot} \`${bitrateStr}\` \`${durStr}\` **${name}**`;
        })
        .join("\n"),
    )
    .setFooter({ text: `${rawResults.length} peers · ✓ = slot free` });

  const rows = [
    new ActionRowBuilder<ButtonBuilder>(),
    new ActionRowBuilder<ButtonBuilder>(),
  ];
  flat.forEach((_r, i) => {
    const row = rows[Math.floor(i / 5)]!;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`download:${storeKey}:${i}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Primary),
    );
  });

  await interaction.editReply({
    content: "",
    embeds: [embed],
    components: rows.filter((r) => r.components.length > 0),
  });
}

export function getPendingResult(
  storeKey: string,
  index: number,
): PendingEntry | undefined {
  return pendingResults.get(storeKey)?.[index];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
