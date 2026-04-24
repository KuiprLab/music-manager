import type { Interaction } from "discord.js";
import type { CommandModule } from "../utils/loader.js";
import { getSlskClient } from "../utils/slskManager.js";
import { getPendingResult } from "../commands/search.js";
import * as path from "node:path";

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

    const name = file.filename.split(/[\\/]/).pop() ?? file.filename;
    await interaction.editReply(
      `Downloading **${name}** from \`${result.username}\`…`,
    );

    const destDir = process.env.DOWNLOAD_DIR ?? "./downloads";

    try {
      const client = await getSlskClient();
      const dl = await client.download({
        username: result.username,
        filename: file.filename,
        destDir,
        onProgress: (_received, _total) => {
          // Could edit the message with progress here — skipping for now
          // to avoid Discord rate limits on editReply
        },
      });

      await interaction.editReply(
        `Downloaded **${path.basename(dl.filePath)}** (${formatBytes(dl.bytes)}) → \`${dl.filePath}\``,
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
