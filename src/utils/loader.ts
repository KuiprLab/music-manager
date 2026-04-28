import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type {
  Client,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

interface EventModule {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => void | Promise<void>;
}

export interface CommandModule {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

async function loadFiles(dir: string): Promise<unknown[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const modules: unknown[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    const filePath = join(dir, entry.name);
    const fileUrl = pathToFileURL(filePath).href;
    const mod: unknown = await import(fileUrl);
    modules.push(mod);
  }

  return modules;
}

export async function loadEvents(
  client: Client,
  eventsDir: string,
): Promise<void> {
  const modules = await loadFiles(eventsDir);

  for (const mod of modules) {
    const event = mod as EventModule;
    if (!event.name || typeof event.execute !== "function") continue;

    if (event.once) {
      client.once(event.name, (...args) => void event.execute(...args));
    } else {
      client.on(event.name, (...args) => void event.execute(...args));
    }
  }
}

export async function loadCommands(
  commandsDir: string,
): Promise<Map<string, CommandModule>> {
  const modules = await loadFiles(commandsDir);
  const commands = new Map<string, CommandModule>();

  for (const mod of modules) {
    const command = mod as CommandModule;
    if (!command.data?.name || typeof command.execute !== "function") continue;
    commands.set(command.data.name, command);
  }

  return commands;
}
