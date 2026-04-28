import { Client, GatewayIntentBits } from "discord.js";
import { configDotenv } from "dotenv";
import { setCommands } from "./events/interactionCreate.js";
import type { CommandModule } from "./utils/loader.js";

// Static command imports
import * as pingCmd from "./commands/ping.js";
import * as albumCmd from "./commands/album.js";
import * as singleCmd from "./commands/single.js";
import * as settingsCmd from "./commands/settings.js";

// Static event imports
import * as readyEvent from "./events/ready.js";
import * as interactionCreateEvent from "./events/interactionCreate.js";

// Redirect console.log to stderr so journald/podman captures it (stdout is buffered in non-TTY)
console.log = console.error;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

interface EventModule {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => void | Promise<void>;
}

function registerEvent(mod: EventModule): void {
  if (mod.once) {
    client.once(mod.name, (...args) => void mod.execute(...args));
  } else {
    client.on(mod.name, (...args) => void mod.execute(...args));
  }
}

async function main(): Promise<void> {
  configDotenv();

  // Register commands
  const commands = new Map<string, CommandModule>();
  for (const cmd of [
    pingCmd,
    albumCmd,
    singleCmd,
    settingsCmd,
  ] as unknown as CommandModule[]) {
    if (cmd.data?.name && typeof cmd.execute === "function") {
      commands.set(cmd.data.name, cmd);
      console.error(`[boot] Registered command: ${cmd.data.name}`);
    }
  }
  setCommands(commands);

  // Register events
  for (const ev of [
    readyEvent,
    interactionCreateEvent,
  ] as unknown as EventModule[]) {
    registerEvent(ev);
    console.error(`[boot] Registered event: ${ev.name}`);
  }

  console.error("[boot] Logging in...");
  await client.login(process.env.DISCORD_TOKEN);
}

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("[fatal] Startup error:", err);
  process.exit(1);
});
