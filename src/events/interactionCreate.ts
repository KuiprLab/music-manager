import type {
  Interaction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { EmbedBuilder } from "discord.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandModule } from "../utils/loader.js";
import { getSlskClient } from "../utils/slskManager.js";
import {
  getPendingResult,
  getPendingResults,
  buildMbEmbed,
  buildSelectComponents,
  buildMainRow,
  formatDuration,
} from "../commands/search.js";
import { MODAL_ID, handleModalSubmit } from "../commands/settings.js";
import { FileAttribute } from "../soulseek-ts/messages/common.js";

export const name = "interactionCreate";
export const once = false;

let commands: Map<string, CommandModule>;

export function setCommands(map: Map<string, CommandModule>): void {
  commands = map;
}

// ─── MB cache helper ──────────────────────────────────────────────────────────

function getMbCacheByKey(
  interaction: Interaction,
  storeKey: string,
): { rec: any; coverUrl: string | undefined } | undefined {
  const cache = (interaction.client as any).__mbCache as
    | Map<string, { rec: any; coverUrl: string | undefined }>
    | undefined;
  return cache?.get(storeKey);
}

export async function execute(interaction: Interaction): Promise<void> {
  // ── Modal submit ───────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (interaction.customId === MODAL_ID) {
      await handleModalSubmit(interaction);
    }
    return;
  }

  // ── Select menu ────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "search" || parts[1] !== "file") return;

    const storeKey = parts[2]!;
    const index = parseInt(interaction.values[0] ?? "0", 10);
    const cached = getMbCacheByKey(interaction, storeKey);

    await doDownload(
      interaction,
      storeKey,
      index,
      cached?.rec,
      cached?.coverUrl,
    );
    return;
  }

  // ── Button interactions ────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "search") return;

    const action = parts[1];
    const storeKey = parts[2]!;
    const cached = getMbCacheByKey(interaction, storeKey);
    const rec = cached?.rec;
    const coverUrl = cached?.coverUrl;

    // ── "Select File…" — show dropdown ──────────────────────────────────────
    if (action === "select") {
      const entries = getPendingResults(storeKey);
      if (!entries || entries.length === 0) {
        await interaction.reply({
          content: "Results expired. Run `/search` again.",
          ephemeral: true,
        });
        return;
      }

      const embed = rec
        ? buildMbEmbed(rec, coverUrl, "ready", "Select a file to download")
        : new EmbedBuilder()
            .setColor(0x5865f2)
            .setDescription("Select a file:");

      const [selectRow, backRow] = buildSelectComponents(storeKey, entries);
      await interaction.update({
        embeds: [embed],
        components: [selectRow, backRow],
      });
      return;
    }

    // ── "Download" — download top result ────────────────────────────────────
    if (action === "download") {
      await doDownload(interaction, storeKey, 0, rec, coverUrl);
      return;
    }

    // ── "← Back" — restore main embed + buttons ─────────────────────────────
    if (action === "back") {
      const entries = getPendingResults(storeKey);
      const readyEmbed = rec
        ? buildMbEmbed(
            rec,
            coverUrl,
            "ready",
            entries ? `${entries.length} files found` : undefined,
          )
        : new EmbedBuilder()
            .setColor(0x57f287)
            .setDescription("Ready to download.");

      await interaction.update({
        embeds: [readyEmbed],
        components: [buildMainRow(storeKey, true)],
      });
      return;
    }
  }

  // ── Slash commands ─────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const command = commands?.get(interaction.commandName);
  if (!command) {
    console.error(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing ${interaction.commandName}:`, error);
    const msg = { content: "An error occurred.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
    }
  }
}

// ─── Download ─────────────────────────────────────────────────────────────────

type UpdatableInteraction = ButtonInteraction | StringSelectMenuInteraction;

async function doDownload(
  interaction: UpdatableInteraction,
  storeKey: string,
  index: number,
  rec: any,
  coverUrl: string | undefined,
): Promise<void> {
  const entry = getPendingResult(storeKey, index);
  if (!entry) {
    await interaction.reply({
      content: "Results expired. Run `/search` again.",
      ephemeral: true,
    });
    return;
  }

  const file = entry.result.files[entry.fileIndex];
  if (!file) {
    await interaction.reply({
      content: "File no longer available.",
      ephemeral: true,
    });
    return;
  }

  const fileName = file.filename.split(/[\\/]/).pop() ?? file.filename;
  const bitrate = file.attrs.get(FileAttribute.Bitrate);
  const duration = file.attrs.get(FileAttribute.Duration);
  const bitrateStr = bitrate ? `${bitrate}kbps` : "?kbps";
  const durStr = duration ? formatDuration(duration) : "?:??";

  const downloadingEmbed = rec
    ? buildMbEmbed(
        rec,
        coverUrl,
        "downloading",
        `Downloading ${bitrateStr} · ${durStr} · ${fileName}`,
      )
    : new EmbedBuilder()
        .setColor(0xfee75c)
        .setDescription(`Downloading **${fileName}**…`);

  await interaction.update({
    embeds: [downloadingEmbed],
    components: [buildMainRow(storeKey, false)],
  });

  const destDir = process.env.DOWNLOAD_DIR ?? "./downloads";
  const tmpDir = path.join(destDir, ".tmp");
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, `${Date.now()}_${fileName}`);
  const outPath = path.join(destDir, fileName);

  try {
    const client = await getSlskClient();
    const download = await client.download(
      entry.result.username,
      file.filename,
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

    const bytes = fs.statSync(outPath).size;
    const doneEmbed = rec
      ? buildMbEmbed(
          rec,
          coverUrl,
          "done",
          `Downloaded ${formatBytes(bytes)} · ${fileName}`,
        )
      : new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription(`Downloaded **${fileName}** (${formatBytes(bytes)})`);

    await interaction.editReply({ embeds: [doneEmbed], components: [] });
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }

    const failEmbed = rec
      ? buildMbEmbed(
          rec,
          coverUrl,
          "searching",
          `Download failed: ${String(err)}`,
        )
      : new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription(`Download failed: ${String(err)}`);

    await interaction.editReply({
      embeds: [failEmbed],
      components: [buildMainRow(storeKey, true)],
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
