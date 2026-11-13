export const CONFIG = {
  brand: "Swipecraft",
  lobby: {
    x: 0,
    y: 80,
    z: 0,
    radius: 24,
    safeRadius: 16,
    dimension: "overworld",
  },
  rtp: {
    minRadius: 120,
    maxRadius: 1800,
    cooldownMs: 90_000,
    attempts: 28,
    minY: 40,
    maxY: 200,
    marginFromBorder: 40,
  },
  border: {
    startRadius: 4000,
    weeklyShrink: 500,
    minRadius: 800,
    checkEveryTicks: 40,
    warnDistance: 30,
    sampleDivisor: 4,
  },
  season: {
    lengthMs: 56 * 24 * 60 * 60 * 1000,
    warnBeforeMs: 24 * 60 * 60 * 1000,
    announceEveryMs: 60 * 60 * 1000,
  },
  limits: {
    tntCheckTicks: 100,
    inventoryScanTicks: 60,
  },
  profiles: {
    flushTicks: 20 * 60,
    maxAuditEntries: 250,
  },
  store: {
    chunkSize: 7000,
  },
} as const;

export const STORE_KEYS = {
  season: "sw:season",
  border: "sw:border",
  acConfig: "sw:ac:cfg",
  audit: "sw:audit",
  profilePrefix: "sw:p:",
} as const;
