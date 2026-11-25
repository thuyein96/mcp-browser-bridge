import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMimeType } from "./mime.js";

const DEFAULT_TOKEN_TTL_MS = 180_000;
const HEADER_SNIFF_BYTES = 16;

export interface RegisteredFile {
  readonly token: string;
  readonly absolutePath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
}

export interface FileStreamRegistryOptions {
  readonly ttlMs?: number;
  readonly cleanupIntervalMs?: number;
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

async function readHeaderBytes(absolutePath: string, sizeBytes: number): Promise<Uint8Array | undefined> {
  if (sizeBytes === 0) {
    return undefined;
  }
  const bytesToRead = Math.min(HEADER_SNIFF_BYTES, sizeBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fs.promises.open(absolutePath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export class FileStreamRegistry {
  private readonly entries = new Map<string, RegisteredFile>();
  private readonly ttlMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options?: FileStreamRegistryOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? Math.max(1_000, Math.min(this.ttlMs, 60_000));
    this.cleanupTimer = setInterval(() => {
      this.purgeExpired();
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async register(inputPath: string): Promise<RegisteredFile> {
    const trimmed = inputPath.trim();
    if (trimmed.length === 0) {
      throw new Error("File path must not be empty.");
    }

    const absolutePath = path.resolve(expandHomePath(trimmed));

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(absolutePath);
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined;
      if (code === "ENOENT") {
        throw new Error(`File not found: ${absolutePath}`);
      }
      if (code === "EACCES") {
        throw new Error(`Permission denied reading file: ${absolutePath}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Unable to inspect file ${absolutePath}: ${message}`);
    }

    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, expected a regular file: ${absolutePath}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Path is not a regular file: ${absolutePath}`);
    }

    const headerBytes = await readHeaderBytes(absolutePath, stats.size);
    const mimeType = detectMimeType(absolutePath, headerBytes);
    const token = crypto.randomBytes(32).toString("hex");
    const entry: RegisteredFile = {
      token,
      absolutePath,
      name: path.basename(absolutePath),
      mimeType,
      sizeBytes: stats.size,
      expiresAt: Date.now() + this.ttlMs,
    };

    this.entries.set(token, entry);
    return entry;
  }

  get(token: string): RegisteredFile | undefined {
    const entry = this.entries.get(token);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(token);
      return undefined;
    }
    return entry;
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.entries.clear();
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(token);
      }
    }
  }
}
