// Reproducible favicon/PNG exports from logo.svg; Node built-ins only.
// Supports the logo's closed absolute M/L/C/Z paths and evenodd fills.
// Run from the repository root: node src/client/pwa/generate-icons.mjs
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const root = new URL("../../../", import.meta.url);
const svg = await readFile(new URL("public/logo.svg", root), "utf8");
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]+)"/g)].map(([, key, value]) => [key, value]));
const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
const viewBox = attrs(svg.match(/<svg\b[^>]+>/)[0]).viewBox.split(/\s+/).map(Number);
const [left, top, width, height] = viewBox, background = rgb("#F2F0E9");
function contours(d) {
  if (/[^MLCZ\d.\s,-]/.test(d)) throw new Error("Logo paths must use absolute M/L/C/Z commands");
  const tokens = d.match(/[MLCZ]|-?\d+(?:\.\d+)?/g), result = [];
  if (!tokens) throw new Error("Empty logo path");
  let points;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    if (command === "Z") {
      if (!points || points.length < 3) throw new Error("Invalid closed logo path");
      result.push(points); points = undefined;
    } else if (command === "M" || command === "L") {
      if (command === "M") {
        if (points) throw new Error("Logo contours must be closed");
        points = [];
      }
      const x = Number(tokens[i++]), y = Number(tokens[i++]);
      if (!points || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid logo coordinates");
      points.push([x, y]);
    } else if (command === "C") {
      const coordinates = tokens.slice(i, i + 6).map(Number); i += 6;
      if (!points?.length || coordinates.length !== 6 || !coordinates.every(Number.isFinite)) throw new Error("Invalid logo curve");
      const [x0, y0] = points.at(-1), [x1, y1, x2, y2, x3, y3] = coordinates;
      // 64 segments keep these short curves smooth at the largest 512px export.
      for (let step = 1; step <= 64; step++) {
        const t = step / 64, u = 1 - t;
        points.push([u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
          u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3]);
      }
    } else throw new Error("Unsupported logo path command");
  }
  if (points) throw new Error("Logo contours must be closed");
  return result;
}
const paths = [...svg.matchAll(/<path\b[^>]+>/g)].map(([tag]) => {
  const { fill, d, "fill-rule": rule } = attrs(tag);
  if (!/^#[\da-f]{6}$/i.test(fill) || rule && rule !== "evenodd") throw new Error("Unsupported logo fill");
  const polygons = contours(d);
  if (polygons.length > 1 && rule !== "evenodd") throw new Error("Multiple contours require evenodd fill");
  return { color: rgb(fill), polygons };
});
if (!paths.length || !viewBox.every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Invalid logo SVG");
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
  const samples = 4, highSize = size * samples, row = Buffer.alloc(highSize * 3);
  // Fill supersampled scanlines instead of walking every contour per sample.
  const totals = new Uint32Array(size * 3);
  const toPixelX = x => ((x - left - width / 2) * scale / width + .5) * highSize;
  for (let highY = 0; highY < highSize; highY++) {
    row.fill(Buffer.from(background));
    const sy = ((highY + .5) / highSize - .5) * height / scale + top + height / 2;
    for (const path of paths) {
      const intersections = [];
      for (const points of path.polygons) for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [ax, ay] = points[i], [bx, by] = points[j];
        if ((ay > sy) !== (by > sy)) intersections.push(ax + (sy - ay) * (bx - ax) / (by - ay));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i < intersections.length; i += 2) {
        const start = Math.max(0, Math.min(highSize, Math.ceil(toPixelX(intersections[i]) - .5)));
        const end = Math.max(0, Math.min(highSize, Math.ceil(toPixelX(intersections[i + 1]) - .5)));
        if (end > start) row.fill(Buffer.from(path.color), start * 3, end * 3);
      }
    }
    for (let x = 0; x < size; x++) for (let dx = 0; dx < samples; dx++) for (let channel = 0; channel < 3; channel++) {
      totals[x * 3 + channel] += row[(x * samples + dx) * 3 + channel];
    }
    if (highY % samples === samples - 1) {
      const offset = Math.floor(highY / samples) * (size * 3 + 1) + 1;
      for (let i = 0; i < totals.length; i++) data[offset + i] = Math.round(totals[i] / samples ** 2);
      totals.fill(0);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(data, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
await mkdir(new URL("public/icons/", root), { recursive: true });
// A paper background keeps the favicon legible on both light and dark browser tabs.
await writeFile(new URL("public/favicon.svg", root), svg.replace(/(<desc[^>]*>[^<]*<\/desc>)/, `$1\n  <path fill="#F2F0E9" d="M ${left} ${top} L ${left + width} ${top} L ${left + width} ${top + height} L ${left} ${top + height} Z"/>`));
for (const [name, size, scale] of [["icon-192.png", 192, .9], ["icon-512.png", 512, .9], ["maskable-512.png", 512, .72]]) {
  await writeFile(new URL(`public/icons/${name}`, root), png(size, scale));
}
