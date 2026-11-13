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

export type DonorTier = "none" | "bronze" | "silver" | "gold";

export type Rarity = "common" | "rare" | "epic" | "legendary";

export type CaseId = "basic" | "elite";

export type ClanRole = "leader" | "officer" | "member";

export interface PlayerMeta {
  name: string;
  updatedAt: number;
  joinedAt: number;
  playSeconds: number;
  banned: boolean;
  coins: number;
  lockedCoins: number;
  lockedUntil: number;
  mintDay: number;
  mintToday: number;
  receiveDay: number;
  receiveToday: number;
  pairDay: number;
  pair: Record<string, number>;
  lastTransferAt: number;
  soldDay: number;
  sold: Record<string, number>;
  caseKeys: number;
  casePulls: number;
  pity: number;
  hearts: number;
  streak: number;
  streakBest: number;
  pvpKills: number;
  pvpDeaths: number;
  streakAt: number;
  donorTier: DonorTier;
  donorUntil: number;
  dailyDay: number;
  dailyStreak: number;
  quests: Record<string, number>;
  claimedQuests: Record<string, number>;
}

export interface EcoTunables {
  transferFeePercent: number;
  marketCommissionPercent: number;
  mintCapPerDay: number;
  maxTransferPerTx: number;
  maxReceivePerDay: number;
  maxPerPairPerDay: number;
  minPlaySecondsForTransfers: number;
  minAccountAgeHours: number;
  clanMaxMembers: number;
  marketTtlDays: number;
  casePricePercent: number;
  queueEnabled: boolean;
  queueSoftCap: number;
  queueReleaseAt: number;
}

export interface EcoAccount {
  name: string;
  coins: number;
}

export interface EcoLedger {
  accounts: Record<string, EcoAccount>;
  minted: number;
  burned: number;
  fees: number;
  day: number;
  mintToday: number;
  txCount: number;
}

export interface TxRecord {
  t: number;
  from: string;
  to: string;
  amount: number;
  fee: number;
  kind: string;
}

export interface SerializedItem {
  typeId: string;
  amount: number;
  nameTag?: string;
  lore?: string[];
  enchant?: { id: string; level: number }[];
}

export interface Listing {
  id: string;
  sellerId: string;
  sellerName: string;
  item: SerializedItem;
  price: number;
  createdAt: number;
  expiresAt: number;
  expired: boolean;
}

export interface ClanMember {
  id: string;
  name: string;
  role: ClanRole;
  joinedAt: number;
  lastSeen: number;
  kills: number;
  points: number;
}

export interface ClanWar {
  clanId: string;
  startedAt: number;
  endsAt: number;
  mine: number;
  theirs: number;
  stake: number;
  matched: boolean;
  attack: boolean;
  settled: boolean;
}

export interface ClanHome {
  x: number;
  y: number;
  z: number;
  dimensionId: string;
}

export interface ClanDoc {
  id: string;
  name: string;
  tag: string;
  createdAt: number;
  updatedAt: number;
  board: string;
  bank: number;
  home?: ClanHome;
  members: ClanMember[];
  invites: { id: string; name: string; at: number; by: string }[];
  wars: ClanWar[];
  score: number;
  wins: number;
  losses: number;
  cooldownAt: number;
  warnedAt: number;
  bankDay: number;
  bankWithdrawn: number;
  homeReadyAt: Record<string, number>;
}

export interface ClansIndex {
  clanIds: string[];
  byPlayer: Record<string, string>;
  names: Record<string, string>;
  totalBytes: number;
}

export interface CaseEntry {
  item: string;
  min: number;
  max: number;
  weight: number;
  rarity: Rarity;
  enchant?: { id: string; level: number }[];
}

export interface CaseDef {
  label: string;
  priceCoins: number;
  priceKeys: number;
  rolls: number;
  pool: CaseEntry[];
}

export interface CaseLogEntry {
  t: number;
  player: string;
  caseId: CaseId;
  item: string;
  amount: number;
  rarity: Rarity;
  paid: number;
  pity: boolean;
}

export interface DonationRequest {
  id: string;
  playerId: string;
  player: string;
  tier: DonorTier;
  days: number;
  note: string;
  at: number;
  status: "open" | "approved" | "rejected";
  by: string;
}

export interface TopRow {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  coins: number;
  points: number;
  streak: number;
  clan: string;
}
