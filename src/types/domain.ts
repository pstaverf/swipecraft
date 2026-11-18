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
  cosmetics: CosmeticState;
  refCode: string;
  refBy: string;
  refBoundAt: number;
  refRewarded: boolean;
  refDay: number;
  refToday: number;
  refMonth: number;
  refMonthCoins: number;
  donBlockUntil: number;
  donBlockReason: string;
}

export interface QuarryDrop {
  typeId: string;
  amount: number;
}

export interface QuarryRow {
  id: string;
  ownerId: string;
  ownerName: string;
  x: number;
  z: number;
  topY: number;
  createdAt: number;
  season: number;
  /** индекс следующей ячейки в детерминированном порядке сканирования */
  scan: number;
  mined: number;
  skipped: number;
  /** буфер заполнен: копать некуда, пока игрок не заберёт добычу */
  full: boolean;
  buffer: QuarryDrop[];
}

export type TotemTierId = "whisper" | "oath" | "ash";

export interface TotemEffectSpec {
  id: string;
  seconds: number;
  amplifier: number;
}

export interface TotemTierSpec {
  coinCost: number;
  emeralds: number;
  charges: number;
  effects: TotemEffectSpec[];
}

/** Запись реестра тотемов: носитель истины о том, сколько спасений ещё «живёт» в предмете. */
export interface TotemRow {
  serial: string;
  tier: TotemTierId;
  charges: number;
  forgedAt: number;
  forgedBy: string;
  season: number;
  /** 0 = активен; иначе момент, когда заряд кончился (запись доживает до прунинга) */
  spentAt: number;
}

export interface TotemDayCounter {
  day: string;
  saves: number;
  forges: number;
}

export interface TotemRegistry {
  season: number;
  rows: TotemRow[];
  day: Record<string, TotemDayCounter>;
  lastSave: Record<string, number>;
}

/** Ответ модов тотемов: ключ словаря + параметры, как в `QuarryResult`. */
export interface TotemResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

export interface TotemTierView {
  id: TotemTierId;
  charges: number;
  coinCost: number;
  emeralds: number;
  effects: TotemEffectSpec[];
}

export type SpawnBuildMode = "build" | "repair";

export interface SpawnBuildState {
  mode: SpawnBuildMode;
  /** индекс следующей ячейки blueprint'а в очереди на запись */
  cursor: number;
  total: number;
  written: number;
  running: boolean;
  startedAt: number;
  lastCheckAt: number;
  missing: number;
  season: number;
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
  donorTrailsEnabled: boolean;
  /** стоп-кран авто-шахты: карьеры перестают копать на следующем такте */
  quarryEnabled: boolean;
  /** стоп-кран тотемов: обряд недоступен, спасение не срабатывает, реестр не трогается */
  totemsEnabled: boolean;
  /** защита спавна: ломать/ставить/взрывать в лобби нельзя никому, включая админов */
  spawnProtectEnabled: boolean;
  /** стоп-кран рангов: префикс не навешивается, из кейса ранг не выпадает */
  ranksEnabled: boolean;
  /** персональная строка статистики под хотбаром */
  hudBarEnabled: boolean;
  /** общий сайдбар (правая панель): на Bedrock это единственный HUD-текст, доступный сразу
   * всем, поэтому строки серверные, а не личные */
  hudSidebarEnabled: boolean;
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

export type CosmeticKind = "trail" | "prefix" | "suffix" | "join";

export interface CosmeticDef {
  id: string;
  kind: CosmeticKind;
  label: string;
  priceCoins: number;
  weight: number;
  rarity: Rarity;
  value: string;
}

export interface CosmeticState {
  owned: string[];
  rolls: number;
  equipped: Record<CosmeticKind, string>;
}

export interface ReferralRow {
  code: string;
  playerId: string;
  name: string;
}

export interface ReferralLogRow {
  t: number;
  kind: "bind" | "reward" | "reject" | "reset";
  referrer: string;
  referee: string;
  detail: string;
}

export interface DonationGoal {
  label: string;
  target: number;
  raised: number;
  deadline: number;
  paidAt: number;
}

export interface ReceiptRow {
  t: number;
  playerId: string;
  name: string;
  item: string;
  via: "coins" | "roll" | "gift" | "donate" | "refund";
  amount: number;
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
