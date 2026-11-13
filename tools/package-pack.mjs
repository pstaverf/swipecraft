import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const walk = async (dir, base = dir, prefix = "") => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base, prefix)));
    else files.push({ full, name: `${prefix}${relative(base, full).split("\\").join("/")}` });
  }
  return files;
};

const zip = async (sourceDir, outFile, prefix = "") => {
  const files = await walk(sourceDir, sourceDir, prefix);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = await readFile(file.full);
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  await writeFile(outFile, Buffer.concat([...chunks, centralBuf, end]));
  return files.length;
};

const outDir = resolve(root, "dist");
await mkdir(outDir, { recursive: true });

const bp = resolve(root, "packs/behavior_pack");
const rp = resolve(root, "packs/resource_pack");
const bpOut = resolve(outDir, "swipecraft_bp.mcpack");
const rpOut = resolve(outDir, "swipecraft_rp.mcpack");

const bpCount = await zip(bp, bpOut);
const rpCount = await zip(rp, rpOut);

const addonOut = resolve(outDir, "swipecraft.mcaddon");
const packsRoot = resolve(outDir, ".packs");
await rm(packsRoot, { recursive: true, force: true });
await mkdir(resolve(packsRoot, "swipecraft_behavior_pack"), { recursive: true });
await mkdir(resolve(packsRoot, "swipecraft_resource_pack"), { recursive: true });
await cp(bp, resolve(packsRoot, "swipecraft_behavior_pack"), { recursive: true });
await cp(rp, resolve(packsRoot, "swipecraft_resource_pack"), { recursive: true });
const addonCount = await zip(packsRoot, addonOut);
await rm(packsRoot, { recursive: true, force: true });

const bpStat = await stat(bpOut);
const rpStat = await stat(rpOut);
console.log(`[pack] ${bpOut} (${bpCount} files, ${bpStat.size} bytes)`);
const addonStat = await stat(addonOut);
console.log(`[pack] ${addonOut} (${addonCount} files, ${addonStat.size} bytes)`);
