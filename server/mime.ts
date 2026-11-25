import path from "node:path";

const EXTENSION_MIME_MAP: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const WEBM_EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const MP4_FTYP_BYTES = [0x66, 0x74, 0x79, 0x70] as const;

function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function detectMimeFromHeader(headerBytes: Uint8Array): string | undefined {
  if (hasBytesAt(headerBytes, 4, MP4_FTYP_BYTES)) {
    return "video/mp4";
  }
  if (hasBytesAt(headerBytes, 0, PNG_MAGIC)) {
    return "image/png";
  }
  if (hasBytesAt(headerBytes, 0, JPEG_MAGIC)) {
    return "image/jpeg";
  }
  if (hasBytesAt(headerBytes, 0, WEBM_EBML_MAGIC)) {
    return "video/webm";
  }
  if (hasBytesAt(headerBytes, 0, PDF_MAGIC)) {
    return "application/pdf";
  }
  return undefined;
}

export function detectMimeType(filePath: string, headerBytes?: Uint8Array): string {
  const ext = path.extname(filePath).toLowerCase();
  const byExt = EXTENSION_MIME_MAP[ext];
  if (byExt !== undefined) {
    return byExt;
  }

  if (headerBytes !== undefined && headerBytes.length > 0) {
    const byMagic = detectMimeFromHeader(headerBytes);
    if (byMagic !== undefined) {
      return byMagic;
    }
  }

  return "application/octet-stream";
}
