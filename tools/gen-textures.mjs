import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
};

const encodePng = (width, height, pixels) => {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = y * (width * 4 + 1) + 1 + x * 4;
      raw[target] = pixels[source];
      raw[target + 1] = pixels[source + 1];
      raw[target + 2] = pixels[source + 2];
      raw[target + 3] = pixels[source + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const solid = (width, height, painter) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = painter(x, y);
      const target = (y * width + x) * 4;
      pixels[target] = color[0];
      pixels[target + 1] = color[1];
      pixels[target + 2] = color[2];
      pixels[target + 3] = color[3] === undefined ? 255 : color[3];
    }
  }
  return pixels;
};

const radial = (size, color, hardness) =>
  solid(size, size, (x, y) => {
    const dx = (x - (size - 1) / 2) / (size / 2);
    const dy = (y - (size - 1) / 2) / (size / 2);
    const distance = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const alpha = Math.round(255 * Math.max(0, 1 - distance ** hardness));
    return [color[0], color[1], color[2], alpha];
  });

const boss = solid(64, 64, (x, y) => {
  const inHead = y < 18 && x >= 18 && x <= 46;
  const inBody = y >= 18 && y < 46 && x >= 10 && x <= 54;
  const inLegs = y >= 46 && ((x >= 14 && x <= 22) || (x >= 42 && x <= 50));
  const horn = (x >= 20 && x <= 26 && y >= 4 && y <= 14) || (x >= 38 && x <= 44 && y >= 4 && y <= 14);
  const eye = (x >= 24 && x <= 28 && y >= 8 && y <= 11) || (x >= 36 && x <= 40 && y >= 8 && y <= 11);
  if (eye) return [250, 214, 120, 255];
  if (horn) return [226, 208, 150, 255];
  if (inHead) return [126, 26, 26, 255];
  if (inBody) return [(x + y) % 7 === 0 ? 148 : 104, 24, 28, 255];
  if (inLegs) return [72, 18, 20, 255];
  return [24, 10, 12, 255];
});

const aura = radial(16, [232, 66, 54], 1.6);
const trail = radial(16, [246, 208, 108], 1.4);
const ember = radial(16, [255, 132, 44], 1.25);
const frost = radial(16, [150, 226, 255], 1.9);
const soul = radial(16, [120, 255, 196], 1.5);
const icon = solid(64, 64, (x, y) => {
  const border = x < 3 || y < 3 || x > 60 || y > 60;
  if (border) return [236, 196, 96, 255];
  const band = y >= 24 && y <= 40 && x >= 12 && x <= 52;
  if (band) return [170, 34, 38, 255];
  return [24, 22, 26, 255];
});

const targets = [
  ["packs/resource_pack/textures/entity/war_boss.png", boss, 64, 64],
  ["packs/resource_pack/textures/particles/boss_aura.png", aura, 16, 16],
  ["packs/resource_pack/textures/particles/donor_trail.png", trail, 16, 16],
  ["packs/resource_pack/textures/particles/trail_ember.png", ember, 16, 16],
  ["packs/resource_pack/textures/particles/trail_frost.png", frost, 16, 16],
  ["packs/resource_pack/textures/particles/trail_soul.png", soul, 16, 16],
];

for (const [relative, pixels, width, height] of targets) {
  const file = resolve(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, encodePng(width, height, pixels));
  console.log(`[textures] ${relative}`);
}
