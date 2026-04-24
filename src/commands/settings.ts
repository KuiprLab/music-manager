import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  LabelBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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

  const bitrateOptions = (label: string, currentValue: Bitrate | "any") =>
    (["any", ...BITRATES] as const).map((b) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(b === "any" ? "Any" : `${b} kbps`)
        .setValue(String(b))
        .setDefault(String(b) === String(currentValue)),
    );

  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle("Download Settings");

  const labelRow = (
    label: string,
    customId: string,
    current: Bitrate | "any",
  ) => {
    const lb = new LabelBuilder()
      .setLabel(label)
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(customId)
          .addOptions(bitrateOptions(customId, current)),
      );
    return (new ActionRowBuilder() as any).addComponents(lb as any) as any;
  };

  modal.addComponents(
    // Formats — free text
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("formats")
        .setLabel("Formats (flac, mp3, ogg, aac, m4a, wav, any)")
        .setStyle(TextInputStyle.Short)
        .setValue(s.formats === "any" ? "any" : s.formats.join(", "))
        .setPlaceholder("flac, mp3  —or—  any")
        .setRequired(true),
    ),
new ActionRowBuilder<TextInputBuilder>().addComponents(
  new TextInputBuilder()
    .setCustomId("min_bitrate")
    .setLabel("Minimum bitrate (e.g. 128, 320, any)")
    .setStyle(TextInputStyle.Short)
    .setValue(String(s.minBitrate))
),

new ActionRowBuilder<TextInputBuilder>().addComponents(
  new TextInputBuilder()
    .setCustomId("preferred_bitrate")
    .setLabel("Preferred bitrate (e.g. 320, any)")
    .setStyle(TextInputStyle.Short)
    .setValue(String(s.preferredBitrate))
),
  );

  await interaction.showModal(modal);
}

export async function handleModalSubmit(
  interaction: import("discord.js").ModalSubmitInteraction,
): Promise<void> {
  const formatsRaw = interaction.fields.getTextInputValue("formats").trim();
  // Bitrate fields are select menus inside Label components — values is the selected values array
  const fields = interaction.fields as any;
  const minBitrateRaw: string =
    fields.getField("min_bitrate")?.values?.[0] ?? "any";
  const preferredBitrateRaw: string =
    fields.getField("preferred_bitrate")?.values?.[0] ?? "any";

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
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Download Settings")
        .setColor(0xfee75c)
        .setDescription(formatSettings(getSettings())),
    ],
    flags: 64,
  });
}
