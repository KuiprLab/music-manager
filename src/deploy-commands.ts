import { REST, Routes } from "discord.js";
import { configDotenv } from "dotenv";

import * as pingCmd from "./commands/ping.js";
import * as albumCmd from "./commands/album.js";
import * as singleCmd from "./commands/single.js";
import * as settingsCmd from "./commands/settings.js";
import type { CommandModule } from "./utils/loader.js";

configDotenv();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing CLIENT_ID in .env");

const allCommands = [
  pingCmd,
  albumCmd,
  singleCmd,
  settingsCmd,
] as unknown as CommandModule[];

console.error("[deploy] Modules loaded:", allCommands.length);
for (const cmd of allCommands) {
  console.error("[deploy] cmd inspection:", {
    hasData: !!cmd.data,
    dataName: cmd.data?.name,
    executeType: typeof cmd.execute,
    keys: Object.keys(cmd as object),
  });
}

const body = allCommands
  .filter((cmd) => cmd.data?.name && typeof cmd.execute === "function")
  .map((cmd) => cmd.data.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

console.error(`Registering ${body.length} command(s)...`);
await rest.put(Routes.applicationCommands(clientId), { body });
console.error("Done.");
