/**
 * Minimal Soulseek client — search only, no uploads/sharing.
 *
 * Protocol ref: https://nicotine-plus.org/doc/SLSKPROTOCOL.html
 *
 * Flow:
 *   1. TCP connect to server.slsknet.org:2242
 *   2. Send Login (code 1)
 *   3. Send SetWaitPort (code 2) with our listen port
 *   4. Send SharedFoldersFiles (code 35) with 0/0 (we share nothing)
 *   5. Send FileSearch (code 26) with a random token + query
 *   6. Server echoes ConnectToPeer (code 18) messages from peers who have results
 *   7. For each ConnectToPeer: open TCP connection to peer, send PeerInit (init code 1)
 *   8. Peer sends back FileSearchResponse (peer code 9) — zlib compressed body
 *   9. Parse and filter results, return when timeout expires
 */

import * as net from "node:net";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileAttribute {
  code: number; // 0=bitrate, 1=duration, 2=VBR, 4=sampleRate, 5=bitDepth
  value: number;
}

export interface SlskFile {
  filename: string;
  size: bigint;
  extension: string;
  attributes: FileAttribute[];
  /** Convenience: bitrate in kbps (attr code 0), or undefined */
  bitrate?: number;
  /** Convenience: duration in seconds (attr code 1), or undefined */
  duration?: number;
}

export interface SlskSearchResult {
  username: string;
  token: number;
  files: SlskFile[];
  slotFree: boolean;
  avgSpeed: number;
  queueLength: number;
}

export interface SearchParams {
  query: string;
  /** Filter: minimum bitrate in kbps */
  minBitrate?: number;
  /** Filter: minimum duration in seconds */
  minDuration?: number;
  /** Filter: allowed file extensions e.g. ['.mp3', '.flac'] */
  extensions?: string[];
  /** How long to collect results (ms). Default: 8000 */
  timeout?: number;
}

export interface SlskClientOptions {
  username: string;
  password: string;
  /** Our listen port — we won't actually listen, but the server requires it */
  listenPort?: number;
}

export interface DownloadParams {
  /** Peer username from search result */
  username: string;
  /** Full filename path as returned in search result */
  filename: string;
  /** Directory to save the downloaded file into */
  destDir: string;
  /** Progress callback: bytes received so far */
  onProgress?: (received: number, total: number) => void;
}

export interface DownloadResult {
  /** Absolute path to the saved file */
  filePath: string;
  /** Total bytes written */
  bytes: number;
}

// ─── Buffer helpers ───────────────────────────────────────────────────────────

function writeUint32LE(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function writeString(s: string): Buffer {
  const str = Buffer.from(s, "utf8");
  const len = writeUint32LE(str.length);
  return Buffer.concat([len, str]);
}

function buildMessage(code: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeUint32LE(code), payload]);
  return Buffer.concat([writeUint32LE(body.length), body]);
}

// Server message (code + payload prepended by length)
function buildServerMsg(code: number, ...parts: Buffer[]): Buffer {
  return buildMessage(code, Buffer.concat(parts));
}

class BufferReader {
  private pos = 0;
  constructor(private buf: Buffer) {}

  get position(): number {
    return this.pos;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  readUint8(): number {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readUint16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readUint32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readInt32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readUint64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readBool(): boolean {
    return this.readUint8() !== 0;
  }

  readString(): string {
    const len = this.readUint32();
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  readIp(): string {
    // Stored as uint32 big-endian (unusual for this protocol)
    const b = this.buf.slice(this.pos, this.pos + 4);
    this.pos += 4;
    return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  }

  skip(n: number): void {
    this.pos += n;
  }
}

// ─── Frame splitter ───────────────────────────────────────────────────────────
// Soulseek frames: [uint32 length][body of that length]

class FrameSplitter {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];

    while (this.buf.length >= 4) {
      const frameLen = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + frameLen) break;
      frames.push(this.buf.slice(4, 4 + frameLen));
      this.buf = this.buf.slice(4 + frameLen);
    }

    return frames;
  }

  /** Return any fully-buffered frames without consuming new data. */
  drain(): Buffer[] {
    return this.push(Buffer.alloc(0));
  }
}

// ─── Peer Init frame (uses uint8 code, not uint32) ───────────────────────────

function buildPeerInitMsg(
  username: string,
  connType: string,
  token: number,
): Buffer {
  const payload = Buffer.concat([
    writeString(username),
    writeString(connType),
    writeUint32LE(token),
  ]);
  // Peer init: [uint32 length][uint8 code][...payload]
  const body = Buffer.concat([Buffer.from([0x01]), payload]);
  return Buffer.concat([writeUint32LE(body.length), body]);
}

// ─── Parse FileSearchResponse (peer code 9) ──────────────────────────────────

function parseSearchResponse(compressed: Buffer): SlskSearchResult | null {
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(compressed);
  } catch {
    return null;
  }

  const r = new BufferReader(raw);

  try {
    const username = r.readString();
    const token = r.readUint32();
    const numResults = r.readUint32();
    const files: SlskFile[] = [];

    for (let i = 0; i < numResults; i++) {
      r.readUint8(); // code, always 1
      const filename = r.readString();
      const size = r.readUint64();
      const extension = r.readString();
      const numAttrs = r.readUint32();
      const attributes: FileAttribute[] = [];

      for (let j = 0; j < numAttrs; j++) {
        const attrCode = r.readUint32();
        const attrValue = r.readUint32();
        attributes.push({ code: attrCode, value: attrValue });
      }

      const bitrate = attributes.find((a) => a.code === 0)?.value;
      const duration = attributes.find((a) => a.code === 1)?.value;

      files.push({ filename, size, extension, attributes, bitrate, duration });
    }

    const slotFree = r.readBool();
    const avgSpeed = r.readUint32();
    const queueLength = r.readUint32();
    // skip unknown uint32
    if (r.remaining() >= 4) r.skip(4);

    return { username, token, files, slotFree, avgSpeed, queueLength };
  } catch {
    return null;
  }
}

// ─── Main client ─────────────────────────────────────────────────────────────

type FrameHandler = (frame: Buffer) => void;

export class SlskClient {
  private socket: net.Socket | null = null;
  private splitter = new FrameSplitter();
  private username = "";
  private frameHandlers = new Set<FrameHandler>();

  private emitFrame(frame: Buffer): void {
    for (const h of this.frameHandlers) h(frame);
  }

  private addFrameHandler(h: FrameHandler): void {
    this.frameHandlers.add(h);
  }

  private removeFrameHandler(h: FrameHandler): void {
    this.frameHandlers.delete(h);
  }

  async connect(opts: SlskClientOptions): Promise<void> {
    this.username = opts.username;
    const { username, password, listenPort = 2234 } = opts;

    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({
        host: "server.slsknet.org",
        port: 2242,
      });
      this.socket = sock;

      sock.once("connect", () => {
        // Login (code 1)
        const hash = createHash("md5")
          .update(username + password)
          .digest("hex");
        const loginMsg = buildServerMsg(
          1,
          writeString(username),
          writeString(password),
          writeUint32LE(157), // major version (Soulseek NS compatible)
          writeString(hash),
          writeUint32LE(100), // minor version
        );
        sock.write(loginMsg);
      });

      // Use a temporary splitter just for the login response, then remove it.
      const loginSplitter = new FrameSplitter();

      const onLoginData = (chunk: Buffer): void => {
        const frames = loginSplitter.push(chunk);
        for (const frame of frames) {
          const code = frame.readUInt32LE(0);
          if (code === 1) {
            sock.removeListener("data", onLoginData);
            // Re-feed any leftover bytes into the shared splitter
            // (loginSplitter may have buffered extra frames beyond login)
            const r = new BufferReader(frame.slice(4));
            const success = r.readBool();
            if (!success) {
              const reason = r.readString();
              reject(new Error(`Soulseek login failed: ${reason}`));
              return;
            }
            // Drain any frames loginSplitter already buffered beyond the login frame
            const leftover = loginSplitter.drain();
            for (const f of leftover) this.emitFrame(f);

            // Permanent data handler: parse frames and fan out to subscribers
            sock.on("data", (c: Buffer) => {
              const frames = this.splitter.push(c);
              for (const f of frames) {
                console.log(
                  `[slsk] server frame code=${f.readUInt32LE(0)} len=${f.length}`,
                );
                this.emitFrame(f);
              }
            });
            // Send SetWaitPort (code 2)
            sock.write(buildServerMsg(2, writeUint32LE(listenPort)));
            // Send SharedFoldersFiles (code 35) — 0 dirs, 0 files
            sock.write(buildServerMsg(35, writeUint32LE(0), writeUint32LE(0)));
            resolve();
          }
        }
      };

      sock.on("data", onLoginData);
    });
  }

  async search(params: SearchParams): Promise<SlskSearchResult[]> {
    if (!this.socket) throw new Error("Not connected");

    const {
      query,
      minBitrate,
      minDuration,
      extensions,
      timeout = 8000,
    } = params;

    const token = Math.floor(Math.random() * 0xffffffff);
    const results: SlskSearchResult[] = [];
    const openPeerConns = new Set<net.Socket>();

    return new Promise<SlskSearchResult[]>((resolve) => {
      const sock = this.socket!;

      const finish = (): void => {
        this.removeFrameHandler(onFrame);
        for (const ps of openPeerConns) ps.destroy();
        resolve(results);
      };

      const timer = setTimeout(finish, timeout);

      const onFrame = (frame: Buffer): void => {
        const code = frame.readUInt32LE(0);

        if (code === 18) {
          // ConnectToPeer — a peer wants to send us search results
          const r = new BufferReader(frame.slice(4));
          const peerUsername = r.readString();
          const connType = r.readString();
          const ipRaw = r.readUint32();
          const port = r.readUint32();
          const peerToken = r.readUint32();

          if (connType !== "P") return;
          if (port === 0) return;

          // Reconstruct IP from LE uint32
          const ip = [
            (ipRaw >>> 0) & 0xff,
            (ipRaw >>> 8) & 0xff,
            (ipRaw >>> 16) & 0xff,
            (ipRaw >>> 24) & 0xff,
          ].join(".");

          console.log(
            `[slsk] ConnectToPeer from ${peerUsername} @ ${ip}:${port}`,
          );

          this.connectToPeer(
            ip,
            port,
            peerUsername,
            peerToken,
            token,
            openPeerConns,
            (result) => {
              const filtered = filterResult(result, {
                minBitrate,
                minDuration,
                extensions,
              });
              if (filtered) results.push(filtered);
            },
          );
        }
      };

      this.addFrameHandler(onFrame);

      // Send FileSearch (code 26)
      sock.write(buildServerMsg(26, writeUint32LE(token), writeString(query)));

      // Safety: if socket dies, resolve early
      sock.once("error", () => {
        clearTimeout(timer);
        finish();
      });
      sock.once("close", () => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  private connectToPeer(
    ip: string,
    port: number,
    peerUsername: string,
    _peerToken: number,
    searchToken: number,
    openConns: Set<net.Socket>,
    onResult: (r: SlskSearchResult) => void,
  ): void {
    const ps = net.createConnection({ host: ip, port, timeout: 5000 });
    openConns.add(ps);

    ps.once("connect", () => {
      // Send PeerInit (init code 1)
      ps.write(buildPeerInitMsg(this.username, "P", 0));
    });

    const peerSplitter = new FrameSplitter();

    ps.on("data", (chunk: Buffer) => {
      const frames = peerSplitter.push(chunk);
      for (const frame of frames) {
        if (frame.length < 4) continue;
        const code = frame.readUInt32LE(0);

        if (code === 9) {
          // FileSearchResponse
          const compressed = frame.slice(4);
          const result = parseSearchResponse(compressed);
          if (result && result.token === searchToken) {
            onResult(result);
          }
          ps.destroy();
          openConns.delete(ps);
        }
      }
    });

    ps.once("error", () => {
      openConns.delete(ps);
    });
    ps.once("close", () => {
      openConns.delete(ps);
    });
    ps.once("timeout", () => {
      ps.destroy();
      openConns.delete(ps);
    });
  }

  /** Ask the server for a peer's IP + port (server code 3). */
  private getPeerAddress(
    peerUsername: string,
  ): Promise<{ ip: string; port: number }> {
    if (!this.socket) return Promise.reject(new Error("Not connected"));
    const sock = this.socket;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeFrameHandler(onFrame);
        reject(new Error(`GetPeerAddress timeout for ${peerUsername}`));
      }, 10_000);

      const onFrame = (frame: Buffer): void => {
        const code = frame.readUInt32LE(0);
        if (code !== 3) return;
        const r = new BufferReader(frame.slice(4));
        const user = r.readString();
        if (user !== peerUsername) return;
        const ipRaw = r.readUint32();
        const port = r.readUint32();
        const ip = [
          (ipRaw >>> 0) & 0xff,
          (ipRaw >>> 8) & 0xff,
          (ipRaw >>> 16) & 0xff,
          (ipRaw >>> 24) & 0xff,
        ].join(".");
        clearTimeout(timer);
        this.removeFrameHandler(onFrame);
        if (port === 0) {
          reject(new Error(`${peerUsername} is not connectable (port 0)`));
        } else {
          resolve({ ip, port });
        }
      };

      this.addFrameHandler(onFrame);
      sock.write(buildServerMsg(3, writeString(peerUsername)));
    });
  }

  /**
   * Download a single file from a peer.
   * Flow: GetPeerAddress → open P-conn → QueueUpload (43)
   *       → peer sends TransferRequest (40) → TransferResponse (41)
   *       → peer opens F-conn → FileTransferInit → FileOffset → stream bytes
   */
  async download(params: DownloadParams): Promise<DownloadResult> {
    const { username, filename, destDir, onProgress } = params;

    // 1. Resolve peer address
    const { ip, port } = await this.getPeerAddress(username);

    // 2. Open P connection and queue the upload
    const token = Math.floor(Math.random() * 0xffffffff);

    const transferReq = await new Promise<{ token: number; fileSize: bigint }>(
      (resolve, reject) => {
        const ps = net.createConnection({ host: ip, port, timeout: 10_000 });

        ps.once("connect", () => {
          ps.write(buildPeerInitMsg(this.username, "P", 0));
          // Send QueueUpload (peer code 43): string filename
          ps.write(buildMessage(43, writeString(filename)));
        });

        const peerSplitter = new FrameSplitter();

        ps.on("data", (chunk: Buffer) => {
          const frames = peerSplitter.push(chunk);
          for (const frame of frames) {
            if (frame.length < 4) continue;
            const code = frame.readUInt32LE(0);

            if (code === 40) {
              // TransferRequest from peer (direction=1 means they will upload to us)
              const r = new BufferReader(frame.slice(4));
              const direction = r.readUint32();
              const tkn = r.readUint32();
              r.readString(); // filename (ignore, we know it)
              const fileSize = direction === 1 ? r.readUint64() : 0n;

              // Send TransferResponse (41): token, allowed=true
              ps.write(
                buildMessage(
                  41,
                  Buffer.concat([writeUint32LE(tkn), Buffer.from([0x01])]),
                ),
              );

              ps.destroy();
              resolve({ token: tkn, fileSize });
            } else if (code === 41) {
              // TransferResponse — peer rejected our queue request
              const r = new BufferReader(frame.slice(4));
              r.readUint32(); // token
              const allowed = r.readBool();
              if (!allowed) {
                const reason = r.remaining() > 4 ? r.readString() : "unknown";
                ps.destroy();
                reject(new Error(`Peer rejected download: ${reason}`));
              }
            }
          }
        });

        ps.once("error", (e) => reject(e));
        ps.once("timeout", () => {
          ps.destroy();
          reject(new Error("P-connection timeout"));
        });
      },
    );

    // 3. Open F connection — peer sends FileTransferInit with our token
    return new Promise<DownloadResult>((resolve, reject) => {
      // We need to listen for the peer to connect TO US on an F connection.
      // Since we don't have a real listen server, we instead re-connect to the
      // peer on an F connection ourselves (slskd-style legacy approach).
      const fs2 = net.createConnection({ host: ip, port, timeout: 30_000 });

      fs2.once("connect", () => {
        fs2.write(buildPeerInitMsg(this.username, "F", transferReq.token));
      });

      // After PeerInit the peer sends FileTransferInit: [uint32 token]
      // Then we send FileOffset: [uint64 0]
      // Then the peer streams raw file bytes.

      let initReceived = false;
      let received = 0;
      const total = Number(transferReq.fileSize);

      const safeName = path.basename(filename.replace(/\\/g, "/"));
      fs.mkdirSync(destDir, { recursive: true });
      const outPath = path.join(destDir, safeName);
      const outStream = fs.createWriteStream(outPath);

      fs2.on("data", (chunk: Buffer) => {
        if (!initReceived) {
          // First 4 bytes = token uint32
          if (chunk.length < 4) return;
          // consume token
          const rest = chunk.slice(4);
          initReceived = true;
          // Send FileOffset = 0
          const offsetBuf = Buffer.alloc(8);
          offsetBuf.writeBigUInt64LE(0n, 0);
          fs2.write(offsetBuf);
          if (rest.length > 0) {
            outStream.write(rest);
            received += rest.length;
            onProgress?.(received, total);
          }
          return;
        }
        outStream.write(chunk);
        received += chunk.length;
        onProgress?.(received, total);
      });

      outStream.once("error", reject);
      fs2.once("error", (e) => {
        outStream.close();
        reject(e);
      });
      fs2.once("timeout", () => {
        fs2.destroy();
        outStream.close();
        reject(new Error("F-connection timeout"));
      });
      fs2.once("close", () => {
        outStream.end(() => resolve({ filePath: outPath, bytes: received }));
      });
    });
  }

  destroy(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function filterResult(
  result: SlskSearchResult,
  filters: Pick<SearchParams, "minBitrate" | "minDuration" | "extensions">,
): SlskSearchResult | null {
  const { minBitrate, minDuration, extensions } = filters;
  const normalizedExts = extensions?.map((e) =>
    e.toLowerCase().replace(/^\./, ""),
  );

  const filtered: SlskFile[] = result.files.filter((f) => {
    if (
      minBitrate !== undefined &&
      (f.bitrate === undefined || f.bitrate < minBitrate)
    ) {
      return false;
    }
    if (
      minDuration !== undefined &&
      (f.duration === undefined || f.duration < minDuration)
    ) {
      return false;
    }
    if (normalizedExts && normalizedExts.length > 0) {
      const ext = f.filename.split(".").pop()?.toLowerCase() ?? "";
      if (!normalizedExts.includes(ext)) return false;
    }
    return true;
  });

  if (filtered.length === 0) return null;
  return { ...result, files: filtered };
}
