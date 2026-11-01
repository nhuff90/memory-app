// Draws the app icons (a magnifying glass with a spark of memory) without any image libraries.
// Run with `npm run icons`; output goes to web/public.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = new URL("../web/public/", import.meta.url);
const TOP = [79, 70, 229]; // indigo-600
const BOTTOM = [55, 48, 163]; // indigo-800
const WHITE = [255, 255, 255];
const SPARK = [251, 191, 36]; // amber-400

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const length = (x, y) => Math.hypot(x, y);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a.map((channel, i) => channel + (b[i] - channel) * t);

function roundedSquare(x, y, half, radius) {
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  return length(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function capsule(x, y, ax, ay, bx, by, radius) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return length(pax - bax * h, pay - bay * h) - radius;
}

/** Signed distances (in icon units, 0..1) to the glyph's white strokes and its spark. */
function glyph(x, y, scale) {
  const u = 0.5 + (x - 0.5) / scale;
  const v = 0.5 + (y - 0.5) / scale;
  const ring = Math.abs(length(u - 0.44, v - 0.44) - 0.2) - 0.0325;
  const handle = capsule(u, v, 0.59, 0.59, 0.72, 0.72, 0.05);
  const spark = length(u - 0.44, v - 0.44) - 0.06;
  return { stroke: Math.min(ring, handle) * scale, spark: spark * scale };
}

function render(size, { fullBleed, glyphScale }) {
  const pixels = Buffer.alloc(size * size * 4);
  const cover = (distance) => clamp(0.5 - distance * size, 0, 1);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const alpha = fullBleed ? 1 : cover(roundedSquare(x, y, 0.5, 0.22));
      let color = mix(TOP, BOTTOM, y);
      const { stroke, spark } = glyph(x, y, glyphScale);
      color = mix(color, WHITE, cover(stroke));
      color = mix(color, SPARK, cover(spark));
      const i = (py * size + px) * 4;
      pixels[i] = Math.round(color[0]);
      pixels[i + 1] = Math.round(color[1]);
      pixels[i + 2] = Math.round(color[2]);
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, pixels);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${TOP})"/><stop offset="1" stop-color="rgb(${BOTTOM})"/></linearGradient></defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <circle cx="44" cy="44" r="20" fill="none" stroke="#fff" stroke-width="6.5"/>
  <line x1="59" y1="59" x2="72" y2="72" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
  <circle cx="44" cy="44" r="6" fill="rgb(${SPARK})"/>
</svg>
`;

mkdirSync(OUT, { recursive: true });
const files = {
  "icon-192.png": render(192, { fullBleed: false, glyphScale: 1 }),
  "icon-512.png": render(512, { fullBleed: false, glyphScale: 1 }),
  // Android crops maskable icons to as little as the central 80% circle.
  "icon-maskable-512.png": render(512, { fullBleed: true, glyphScale: 0.72 }),
  // iOS rounds the corners itself and shows transparency as black.
  "apple-touch-icon.png": render(180, { fullBleed: true, glyphScale: 0.9 }),
  "favicon.svg": svg,
};
for (const [name, data] of Object.entries(files)) writeFileSync(new URL(name, OUT), data);
console.log(`Wrote ${Object.keys(files).join(", ")} to web/public`);
