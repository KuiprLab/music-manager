import type { Client } from "discord.js";
import { getSlskClient } from "../utils/slskManager.js";

export const name = "clientReady";
export const once = true;

export async function execute(c: Client<true>): Promise<void> {
  console.log(`Ready! Logged in as ${c.user.tag}`);

  try {
    await getSlskClient();
  } catch (err) {
    console.error("[slsk] Failed to connect:", err);
  }
}
