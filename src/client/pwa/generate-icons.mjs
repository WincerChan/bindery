// Reproducible PNG rasterizer for the existing two-shape favicon; Node built-ins only.
// Run from the repository root: node src/client/pwa/generate-icons.mjs
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const root = new URL("../../../", import.meta.url);
const svg = await readFile(new URL("public/favicon.svg", root), "utf8");
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]+)"/g)].map(([, key, value]) => [key, value]));
const rect = attrs(svg.match(/<rect\b[^>]+>/)[0]), circle = attrs(svg.match(/<circle\b[^>]+>/)[0]);
if (!/viewBox="0 0 24 24"/.test(svg)) throw new Error("Update the rasterizer for the new favicon viewBox");
const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
const ink = rgb(rect.fill), accent = rgb(circle.fill), background = rgb("#F5F6F3");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function png(size, scale) {
  const data = Buffer.alloc(size * (size * 3 + 1));
  const samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const color = [0, 0, 0];
    for (let dy = 0; dy < samples; dy++) for (let dx = 0; dx < samples; dx++) {
      const sx = ((x + (dx + .5) / samples) / size - .5) * 24 / scale + 12.5;
      const sy = ((y + (dy + .5) / samples) / size - .5) * 24 / scale + 11.5;
      let pixel = background;
      if (sx >= +rect.x && sx <= +rect.x + +rect.width && sy >= +rect.y && sy <= +rect.y + +rect.height) pixel = ink;
      if ((sx - +circle.cx) ** 2 + (sy - +circle.cy) ** 2 <= (+circle.r) ** 2) pixel = accent;
      for (let channel = 0; channel < 3; channel++) color[channel] += pixel[channel];
    }
    for (let channel = 0; channel < 3; channel++) data[y * (size * 3 + 1) + 1 + x * 3 + channel] = Math.round(color[channel] / samples ** 2);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(data, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
await mkdir(new URL("public/icons/", root), { recursive: true });
for (const [name, size, scale] of [["icon-192.png", 192, .9], ["icon-512.png", 512, .9], ["maskable-512.png", 512, .6]]) {
  await writeFile(new URL(`public/icons/${name}`, root), png(size, scale));
}
