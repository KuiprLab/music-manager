import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { getSlskClient } from "../utils/slskManager.js";
import type { SlskSearchResult } from "../utils/slsk.js";

export const data = new SlashCommandBuilder()
  .setName("search")
  .setDescription("Search for music on Soulseek")
  .addStringOption((opt) =>
    opt
      .setName("query")
      .setDescription("Artist, album or track name")
      .setRequired(true),
  );

// In-memory store of pending results keyed by interaction id
// (Discord gives us 15 min on the token, good enough)
const pendingResults = new Map<
  string,
  { result: SlskSearchResult; fileIndex: number }[]
>();

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

  const rawResults = await client.search({ query, timeout: 10_000 });

  if (rawResults.length === 0) {
    await interaction.editReply(`No results found for **${query}**.`);
    return;
  }

  // Flatten to individual files, sort by quality
  const flat = rawResults
    .flatMap((r) =>
      r.files.map((f, i) => ({ result: r, fileIndex: i, file: f })),
    )
    .sort((a, b) => {
      // Prefer slot-free peers, then higher bitrate
      if (a.result.slotFree !== b.result.slotFree)
        return a.result.slotFree ? -1 : 1;
      return (b.file.bitrate ?? 0) - (a.file.bitrate ?? 0);
    })
    .slice(0, 10);

  // Store for button handler
  const storeKey = interaction.id;
  pendingResults.set(
    storeKey,
    flat.map(({ result, fileIndex }) => ({ result, fileIndex })),
  );
  // Auto-clean after 15 min
  setTimeout(() => pendingResults.delete(storeKey), 15 * 60 * 1000);

  const embed = new EmbedBuilder()
    .setTitle(`Results for "${query}"`)
    .setColor(0x5865f2)
    .setDescription(
      flat
        .map(({ result, file }, i) => {
          const name = file.filename.split(/[\\/]/).pop() ?? file.filename;
          const bitrate = file.bitrate ? `${file.bitrate}kbps` : "?kbps";
          const dur = file.duration ? formatDuration(file.duration) : "?:??";
          const slot = result.slotFree ? "✓" : "·";
          return `\`${i + 1}.\` ${slot} \`${bitrate}\` \`${dur}\` **${name}**`;
        })
        .join("\n"),
    )
    .setFooter({ text: `${rawResults.length} peers · ✓ = slot free` });

  // Buttons 1–10 across two rows (max 5 per row)
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
): { result: SlskSearchResult; fileIndex: number } | undefined {
  return pendingResults.get(storeKey)?.[index];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
