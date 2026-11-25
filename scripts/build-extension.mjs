import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const extSrcDir = path.join(rootDir, "extension", "src");
const extDir = path.join(rootDir, "extension");
const outDir = path.join(extDir, "dist");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "icons"), { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: ["chrome120"],
  platform: "browser",
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(extSrcDir, "background.ts")],
    outfile: path.join(outDir, "background.js"),
    format: "esm",
  }),
  build({
    ...common,
    entryPoints: [path.join(extSrcDir, "content.ts")],
    outfile: path.join(outDir, "content.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [path.join(extSrcDir, "popup.ts")],
    outfile: path.join(outDir, "popup.js"),
    format: "esm",
  }),
]);

for (const file of ["manifest.json", "popup.html", "popup.css"]) {
  fs.copyFileSync(path.join(extDir, file), path.join(outDir, file));
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.44;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= radius) {
        const innerArrow =
          Math.abs(dx) <= size * 0.1 && dy >= -size * 0.12 && dy <= size * 0.22
            ? true
            : dy <= -size * 0.04 && dy >= -size * 0.24 && Math.abs(dx) <= (dy + size * 0.26) * 1.1;
        if (innerArrow) {
          raw[px] = 255;
          raw[px + 1] = 255;
          raw[px + 2] = 255;
          raw[px + 3] = 255;
        } else {
          raw[px] = 217;
          raw[px + 1] = 119;
          raw[px + 2] = 87;
          raw[px + 3] = 255;
        }
      } else {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, "icons", `icon${size}.png`), makeIconPng(size));
}

console.log(`Built extension into ${outDir}`);
