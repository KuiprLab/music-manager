/**
 * Singleton wrapper around SlskClient.
 * Connect once on bot ready; reuse for every search/download.
 */

import { SlskClient } from "./slsk.js";

let client: SlskClient | null = null;

export async function getSlskClient(): Promise<SlskClient> {
  if (client) return client;

  const username = process.env.SLSK_USERNAME;
  const password = process.env.SLSK_PASSWORD;

  if (!username || !password) {
    throw new Error("SLSK_USERNAME / SLSK_PASSWORD missing from .env");
  }

  client = new SlskClient();
  await client.connect({ username, password });
  console.log(`[slsk] Connected as ${username}`);
  return client;
}

export function destroySlskClient(): void {
  client?.destroy();
  client = null;
}
