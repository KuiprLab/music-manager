import { REST, Routes } from "discord.js";
import { configDotenv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommands } from "./utils/loader.js";

configDotenv();

const __dirname = dirname(fileURLToPath(import.meta.url));

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing CLIENT_ID in .env");

const commands = await loadCommands(join(__dirname, "commands"));
const body = [...commands.values()].map((cmd) => cmd.data.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

console.log(`Registering ${body.length} command(s)...`);
await rest.put(Routes.applicationCommands(clientId), { body });
console.log("Done.");
