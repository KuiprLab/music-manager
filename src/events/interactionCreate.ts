import type { Interaction } from "discord.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandModule } from "../utils/loader.js";
import { getSlskClient } from "../utils/slskManager.js";
import { getPendingResult } from "../commands/search.js";
import { FileAttribute } from "../soulseek-ts/messages/common.js";

export const name = "interactionCreate";
export const once = false;

let commands: Map<string, CommandModule>;

export function setCommands(map: Map<string, CommandModule>): void {
  commands = map;
}

export async function execute(interaction: Interaction): Promise<void> {
  // ── Button interactions ──────────────────────────────────────────────────
  if (interaction.isButton()) {
    const [prefix, storeKey, indexStr] = interaction.customId.split(":");
    if (prefix !== "download" || !storeKey || !indexStr) return;

    const index = parseInt(indexStr, 10);
    const entry = getPendingResult(storeKey, index);

    if (!entry) {
      await interaction.reply({
        content: "Result expired. Run `/search` again.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const { result, fileIndex } = entry;
    const file = result.files[fileIndex];

    if (!file) {
      await interaction.editReply("File no longer available.");
      return;
    }

    const fileName = file.filename.split(/[\\/]/).pop() ?? file.filename;
    await interaction.editReply(
      `Downloading **${fileName}** from \`${result.username}\`…`,
    );

    const destDir = process.env.DOWNLOAD_DIR ?? "./downloads";
    fs.mkdirSync(destDir, { recursive: true });
    const outPath = path.join(destDir, fileName);

    try {
      const client = await getSlskClient();
      const download = await client.download(result.username, file.filename);

      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(outPath);
        download.stream.pipe(out);
        download.stream.on("error", reject);
        out.on("error", reject);
        download.events.on("complete", () => resolve());
        // Fallback: resolve when stream ends naturally
        download.stream.on("end", () => resolve());
      });

      const bytes = fs.statSync(outPath).size;
      await interaction.editReply(
        `Downloaded **${fileName}** (${formatBytes(bytes)}) → \`${outPath}\``,
      );
    } catch (err) {
      await interaction.editReply(`Download failed: ${String(err)}`);
    }

    return;
  }

  // ── Slash commands ───────────────────────────────────────────────────────
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
