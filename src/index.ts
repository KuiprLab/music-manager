import { Client, GatewayIntentBits } from "discord.js";
import { configDotenv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvents, loadCommands } from "./utils/loader.js";
import { setCommands } from "./events/interactionCreate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main(): Promise<void> {
  configDotenv();

  const commands = await loadCommands(join(__dirname, "commands"));
  setCommands(commands);

  await loadEvents(client, join(__dirname, "events"));

  await client.login(process.env.DISCORD_TOKEN);
}

main();
