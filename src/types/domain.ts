export type Lang = "ru" | "en";

export type DetectorId =
  | "reach"
  | "attackRate"
  | "speed"
  | "fly"
  | "nuke"
  | "placeRate"
  | "containerSpam"
  | "entitySpam"
  | "stackAnomaly";

export interface Profile {
  name: string;
  lang: Lang;
  kills: number;
  deaths: number;
  playSeconds: number;
  joinedAt: number;
  lastSeen: number;
  banned: boolean;
  banReason: string;
  banUntil: number;
  acScore: number;
  flags: Partial<Record<DetectorId, number>>;
  rtpReadyAt: number;
  mobile: boolean;
}

export interface AuditEntry {
  t: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export interface SeasonState {
  index: number;
  startedAt: number;
  wipeArmed: boolean;
  armedBy: string;
  armedAt: number;
  lastWarnAt: number;
  code: string;
}

export interface BorderState {
  radius: number;
  updatedAt: number;
  week: number;
}

export interface DetectorConfig {
  enabled: boolean;
  weight: number;
  windowMs: number;
  hits: number;
  tolerance: number;
  mobileToleranceBonus: number;
  graceMs: number;
}

export interface AcConfig {
  threshold: number;
  alertCooldownMs: number;
  decayPerMinute: number;
  detectors: Record<DetectorId, DetectorConfig>;
  limits: {
    maxStackAmount: number;
    containerOpsPerWindow: number;
    containerWindowMs: number;
    entityOpsPerWindow: number;
    entityWindowMs: number;
    maxTntPerArea: number;
    tntAreaRadius: number;
    hopperPerChunk: number;
    observerPerChunk: number;
    pistonPerChunk: number;
    breakRatePerWindow: number;
    breakWindowMs: number;
    placeRatePerWindow: number;
    placeWindowMs: number;
  };
}
