import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  getSettings,
  updateSettings,
  formatSettings,
  FORMATS,
  BITRATES,
  type Format,
  type Bitrate,
} from "../utils/settings.js";

export const MODAL_ID = "settings:modal";

export const data = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("View or change download preferences");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const s = getSettings();

  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle("Download Settings")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("formats")
          .setLabel("Formats (e.g. flac, mp3 — or — any)")
          .setStyle(TextInputStyle.Short)
          .setValue(s.formats === "any" ? "any" : s.formats.join(", "))
          .setPlaceholder(`Options: ${FORMATS.join(", ")}, any`)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("min_bitrate")
          .setLabel("Min bitrate (128/192/256/320 or any)")
          .setStyle(TextInputStyle.Short)
          .setValue(s.minBitrate === "any" ? "any" : String(s.minBitrate))
          .setPlaceholder("e.g. 192  or  any")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("preferred_bitrate")
          .setLabel("Preferred bitrate (128/192/256/320 or any)")
          .setStyle(TextInputStyle.Short)
          .setValue(
            s.preferredBitrate === "any" ? "any" : String(s.preferredBitrate),
          )
          .setPlaceholder("e.g. 320  or  any")
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const formatsRaw = interaction.fields.getTextInputValue("formats").trim();
  const minBitrateRaw = interaction.fields
    .getTextInputValue("min_bitrate")
    .trim();
  const preferredBitrateRaw = interaction.fields
    .getTextInputValue("preferred_bitrate")
    .trim();

  const patch: Parameters<typeof updateSettings>[0] = {};
  const errors: string[] = [];

  if (formatsRaw.toLowerCase() === "any") {
    patch.formats = "any";
  } else {
    const requested = formatsRaw
      .split(",")
      .map((f) => f.trim().toLowerCase().replace(/^\./, ""));
    const invalid = requested.filter((f) => !FORMATS.includes(f as Format));
    if (invalid.length > 0) {
      errors.push(
        `Unknown formats: ${invalid.join(", ")}. Valid: ${FORMATS.join(", ")}`,
      );
    } else {
      patch.formats = requested as Format[];
    }
  }

  if (minBitrateRaw.toLowerCase() === "any") {
    patch.minBitrate = "any";
  } else {
    const n = parseInt(minBitrateRaw);
    if (!BITRATES.includes(n as Bitrate)) {
      errors.push(
        `Invalid min bitrate "${minBitrateRaw}". Valid: ${BITRATES.join(", ")}, any`,
      );
    } else {
      patch.minBitrate = n as Bitrate;
    }
  }

  if (preferredBitrateRaw.toLowerCase() === "any") {
    patch.preferredBitrate = "any";
  } else {
    const n = parseInt(preferredBitrateRaw);
    if (!BITRATES.includes(n as Bitrate)) {
      errors.push(
        `Invalid preferred bitrate "${preferredBitrateRaw}". Valid: ${BITRATES.join(", ")}, any`,
      );
    } else {
      patch.preferredBitrate = n as Bitrate;
    }
  }

  if (errors.length > 0) {
    await interaction.reply({ content: errors.join("\n"), flags: 64 });
    return;
  }

  updateSettings(patch);
  await interaction.reply({ embeds: [settingsEmbed()], flags: 64 });
}

function settingsEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Download Settings")
    .setColor(0xfee75c)
    .setDescription(formatSettings(getSettings()));
}
