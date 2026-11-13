import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { clearWorldJson, dynamicPropertyBudget, loadWorldJson, saveWorldJson } from "../kernel/store";
import { clamp } from "../kernel/util";
import { audit, notifyAdmins } from "../security/audit";
import { CLANS, META_KEYS } from "./config";
import { accountBalance, balance, burn, burnAccount, depositToAccount, getTunables, transferBetweenAccounts, withdrawFromAccount } from "./economy";
import "./messages";
import type { ClanDoc, ClanMember, ClanRole, ClanWar, ClansIndex } from "../types/domain";

export interface ClanResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

const NAME_RE = /^[0-9A-Za-zА-Яа-яЁё_\-]{3,20}$/;
const TAG_RE = /^[0-9A-Za-zА-Яа-яЁё]{3,6}$/;
const CACHE_LIMIT = 40;
const DAY_MS = 86_400_000;

let index: ClansIndex = { clanIds: [], byPlayer: {}, names: {}, totalBytes: 0 };
let indexDirty = false;

const docs = new Map<string, ClanDoc>();
const dirtyDocs = new Set<string>();

const keyOf = (clanId: string): string => `${META_KEYS.clanPrefix}${clanId}`;

const accountIdOf = (clanId: string): string => `clan:${clanId}`;

const cloneIndex = (source: ClansIndex): ClansIndex => JSON.parse(JSON.stringify(source)) as ClansIndex;

const persistIndex = (): void => {
  const copy = cloneIndex(index);
  const bytes = JSON.stringify(copy).length;
  if (bytes > CLANS.storage.indexBudgetBytes) {
    notifyAdmins(`[clans] индекс кланов раздут (${bytes} байт): удали неактивные кланы`);
    return;
  }
  index.totalBytes = bytes;
  saveWorldJson(META_KEYS.clans, index);
  indexDirty = false;
};

const normalizeDoc = (raw: Partial<ClanDoc>, clanId: string): ClanDoc => ({
  id: clanId,
  name: typeof raw.name === "string" ? raw.name : clanId,
  tag: typeof raw.tag === "string" ? raw.tag : "???",
  createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
  updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  board: typeof raw.board === "string" ? raw.board.slice(0, CLANS.boardChars) : "",
  bank: 0,
  home: raw.home && typeof raw.home.x === "number" ? raw.home : undefined,
  members: Array.isArray(raw.members) ? raw.members.filter((member): member is ClanMember => !!member && typeof member.id === "string") : [],
  invites: Array.isArray(raw.invites) ? raw.invites.filter((row) => !!row && typeof row.id === "string") : [],
  wars: Array.isArray(raw.wars) ? raw.wars.filter((row): row is ClanWar => !!row && typeof row.clanId === "string") : [],
  score: typeof raw.score === "number" ? raw.score : 0,
  wins: typeof raw.wins === "number" ? raw.wins : 0,
  losses: typeof raw.losses === "number" ? raw.losses : 0,
  cooldownAt: typeof raw.cooldownAt === "number" ? raw.cooldownAt : 0,
  warnedAt: typeof raw.warnedAt === "number" ? raw.warnedAt : 0,
  bankDay: typeof raw.bankDay === "number" ? raw.bankDay : 0,
  bankWithdrawn: typeof raw.bankWithdrawn === "number" ? raw.bankWithdrawn : 0,
  homeReadyAt: raw.homeReadyAt && typeof raw.homeReadyAt === "object" ? raw.homeReadyAt : {},
});

const budgetOk = (extraBytes: number): boolean => {
  const used = dynamicPropertyBudget();
  if (used < 0) return true;
  return used + extraBytes < CLANS.storage.totalBudgetBytes;
};

const saveDoc = (doc: ClanDoc): boolean => {
  doc.bank = accountBalance(accountIdOf(doc.id));
  const bytes = JSON.stringify(doc).length;
  if (bytes > CLANS.storage.perClanBudgetBytes) {
    log.error("clans", `${doc.name}: документ ${bytes} байт превышает лимит ${CLANS.storage.perClanBudgetBytes}`);
    return false;
  }
  if (!budgetOk(bytes + 128)) {
    notifyAdmins(`[clans] глобальное хранилище dynamic properties переполнено: ${doc.name} не сохранён, данные в памяти`);
    return false;
  }
  saveWorldJson(keyOf(doc.id), doc);
  dirtyDocs.delete(doc.id);
  return true;
};

const loadDoc = (clanId: string): ClanDoc | undefined => {
  const cached = docs.get(clanId);
  if (cached) return cached;
  if (docs.size >= CACHE_LIMIT) {
    for (const id of docs.keys()) {
      if (dirtyDocs.has(id)) continue;
      docs.delete(id);
      break;
    }
  }
  const raw = loadWorldJson<Partial<ClanDoc> | undefined>(keyOf(clanId), undefined);
  if (!raw) return undefined;
  const doc = normalizeDoc(raw, clanId);
  docs.set(clanId, doc);
  return doc;
};

const touchDoc = (doc: ClanDoc): void => {
  doc.updatedAt = Date.now();
  dirtyDocs.add(doc.id);
};

const commit = (doc: ClanDoc): boolean => {
  const ok = saveDoc(doc);
  if (indexDirty) persistIndex();
  return ok;
};

export const loadClans = (): number => {
  const stored = loadWorldJson<ClansIndex | undefined>(META_KEYS.clans, undefined);
  if (stored && typeof stored === "object") {
    index = {
      clanIds: Array.isArray(stored.clanIds) ? stored.clanIds.filter((id): id is string => typeof id === "string") : [],
      byPlayer: stored.byPlayer && typeof stored.byPlayer === "object" ? stored.byPlayer : {},
      names: stored.names && typeof stored.names === "object" ? stored.names : {},
      totalBytes: typeof stored.totalBytes === "number" ? stored.totalBytes : 0,
    };
  }
  for (const clanId of index.clanIds) loadDoc(clanId);
  return index.clanIds.length;
};

export const clanIdOf = (playerId: string): string | undefined => index.byPlayer[playerId];

export const clanOf = (playerId: string): ClanDoc | undefined => {
  const clanId = index.byPlayer[playerId];
  return clanId ? loadDoc(clanId) : undefined;
};

export const memberOf = (doc: ClanDoc, playerId: string): ClanMember | undefined =>
  doc.members.find((member) => member.id === playerId);

export const roleOf = (doc: ClanDoc, playerId: string): ClanRole | undefined => memberOf(doc, playerId)?.role;

export const canDo = (doc: ClanDoc, playerId: string, action: string): boolean => {
  const role = roleOf(doc, playerId);
  if (!role) return false;
  return CLANS.rolePermissions[role].includes(action);
};

const findByName = (name: string): Player | undefined => {
  const lowered = name.toLowerCase();
  return world.getAllPlayers().find((player) => player.name.toLowerCase() === lowered);
};

const syncMember = (doc: ClanDoc): void => {
  const now = Date.now();
  let changed = false;
  for (const member of doc.members) {
    const player = findByName(member.name);
    if (!player) continue;
    if (player.id !== member.id) continue;
    if (member.lastSeen + 300_000 < now) {
      member.lastSeen = now;
      changed = true;
    }
  }
  if (changed) touchDoc(doc);
};

export const clanStatus = (player: Player): string[] => {
  const doc = clanOf(player.id);
  if (!doc) {
    const invites = invitesFor(player);
    const lines = [t(player, "clan.none")];
    if (invites.length > 0) lines.push(...invites);
    return lines;
  }
  syncMember(doc);
  const member = memberOf(doc, player.id);
  const bank = accountBalance(accountIdOf(doc.id));
  const lines = [t(player, "clan.status.header", { name: doc.name, tag: doc.tag, members: doc.members.length, max: getTunables().clanMaxMembers })];
  lines.push(t(player, "clan.status.role", { role: member?.role ?? "—" }));
  lines.push(t(player, "clan.status.score", { score: doc.score, wins: doc.wins, losses: doc.losses }));
  lines.push(t(player, "clan.status.bank", { bank }));
  lines.push(
    doc.home
      ? t(player, "clan.status.home", {
          coords: `${Math.round(doc.home.x)} ${Math.round(doc.home.y)} ${Math.round(doc.home.z)} (${doc.home.dimensionId})`,
          cost: CLANS.homeTeleportCost,
          cooldown: Math.round(CLANS.homeCooldownMs / 60000),
        })
      : t(player, "clan.status.homeNone"),
  );
  if (doc.board.length > 0) lines.push(t(player, "clan.status.board", { text: doc.board }));
  for (const war of doc.wars) {
    const enemy = loadDoc(war.clanId);
    lines.push(
      t(player, "clan.status.war", {
        enemy: enemy?.name ?? war.clanId,
        mine: war.mine,
        theirs: war.theirs,
        ends: new Date(war.endsAt).toISOString().slice(5, 16).replace("T", " "),
        state: war.matched ? "" : t(player, "clan.status.warPending"),
      }),
    );
  }
  return lines;
};

export const clanMembers = (player: Player): string[] => {
  const doc = clanOf(player.id);
  if (!doc) return [];
  return doc.members
    .slice()
    .sort((left, right) => right.points - left.points)
    .map((member) =>
      t(player, "clan.member.line", {
        mark: member.role === "leader" ? "★" : member.role === "officer" ? "☆" : "·",
        name: member.name,
        kills: member.kills,
        points: member.points,
      }),
    );
};

export const createClan = (player: Player, name: string, tag: string, fee: number): ClanResult => {
  const cleanName = name.trim();
  const cleanTag = tag.trim().toUpperCase();
  if (!NAME_RE.test(cleanName)) return { ok: false, key: "clan.name.invalid" };
  if (!TAG_RE.test(cleanTag)) return { ok: false, key: "clan.tag.invalid" };
  if (index.byPlayer[player.id]) return { ok: false, key: "clan.already" };
  if (Object.values(index.names).includes(cleanName)) return { ok: false, key: "clan.name.taken" };
  if (index.clanIds.length >= CLANS.storage.maxClans) return { ok: false, key: "clan.limit" };
  const projected = JSON.stringify({ ...index, clanIds: [...index.clanIds, "x"] }).length + CLANS.storage.perClanBudgetBytes;
  if (!budgetOk(projected)) {
    notifyAdmins("[clans] создание клана заблокировано: хранилище dynamic properties близко к лимиту");
    return { ok: false, key: "clan.storage" };
  }
  const clanId = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  if (fee > 0) {
    const burned = burn(player, fee, "clan create");
    if (!burned.ok) return { ok: false, key: burned.key, params: burned.params };
  }
  const doc: ClanDoc = normalizeDoc(
    {
      id: clanId,
      name: cleanName,
      tag: cleanTag,
      members: [{ id: player.id, name: player.name, role: "leader", joinedAt: Date.now(), lastSeen: Date.now(), kills: 0, points: 0 }],
    },
    clanId,
  );
  if (!saveDoc(doc)) {
    if (fee > 0) depositToAccount(player, accountIdOf(clanId), cleanName, fee);
    return { ok: false, key: "clan.storage" };
  }
  docs.set(clanId, doc);
  index.clanIds.push(clanId);
  index.byPlayer[player.id] = clanId;
  index.names[clanId] = cleanName;
  indexDirty = true;
  persistIndex();
  audit("clans", "create", player.name, `${cleanName} [${cleanTag}] ${fee}`);
  return { ok: true, key: "clan.created", params: { name: cleanName, tag: cleanTag, fee } };
};

export const invitePlayer = (player: Player, targetName: string): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "invite")) return { ok: false, key: "clan.perm" };
  const target = findByName(targetName);
  if (!target) return { ok: false, key: "clan.offline" };
  if (index.byPlayer[target.id]) return { ok: false, key: "clan.targetBusy" };
  if (doc.members.length >= getTunables().clanMaxMembers) return { ok: false, key: "clan.full", params: { max: getTunables().clanMaxMembers } };
  if (doc.invites.some((row) => row.id === target.id)) return { ok: false, key: "clan.invited" };
  doc.invites = doc.invites.filter((row) => Date.now() - row.at < CLANS.inviteTtlMs).slice(-CLANS.maxInvites);
  doc.invites.push({ id: target.id, name: target.name, at: Date.now(), by: player.name });
  touchDoc(doc);
  commit(doc);
  audit("clans", "invite", `${player.name}->${target.name}`, doc.name);
  try {
    target.sendMessage(t(target, "clan.invite.notify", { by: player.name, name: doc.name, tag: doc.tag }));
  } catch {
    return { ok: true, key: "clan.inviteSent", params: { name: target.name } };
  }
  return { ok: true, key: "clan.inviteSent", params: { name: target.name } };
};

export const joinClan = (player: Player): ClanResult => {
  if (index.byPlayer[player.id]) return { ok: false, key: "clan.already" };
  for (const clanId of index.clanIds) {
    const doc = loadDoc(clanId);
    if (!doc) continue;
    const invite = doc.invites.find((row) => row.id === player.id);
    if (!invite) continue;
    if (Date.now() - invite.at > CLANS.inviteTtlMs) {
      doc.invites = doc.invites.filter((row) => row.id !== player.id);
      touchDoc(doc);
      commit(doc);
      continue;
    }
    if (doc.members.length >= getTunables().clanMaxMembers) return { ok: false, key: "clan.full", params: { max: getTunables().clanMaxMembers } };
    doc.members.push({ id: player.id, name: player.name, role: "member", joinedAt: Date.now(), lastSeen: Date.now(), kills: 0, points: 0 });
    doc.invites = doc.invites.filter((row) => row.id !== player.id);
    index.byPlayer[player.id] = doc.id;
    indexDirty = true;
    touchDoc(doc);
    commit(doc);
    persistIndex();
    notifyClan(doc, "clan.notify.joined", { name: player.name });
    audit("clans", "join", player.name, doc.name);
    return { ok: true, key: "clan.joined", params: { name: doc.name } };
  }
  return { ok: false, key: "clan.noInvite" };
};

export const leaveClan = (player: Player): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  const member = memberOf(doc, player.id);
  if (!member) return { ok: false, key: "clan.none" };
  if (member.role === "leader") {
    const successor = doc.members.find((row) => row.role === "officer") ?? doc.members.find((row) => row.id !== player.id);
    if (!successor) return disbandClan(player, false);
    successor.role = "leader";
    doc.members = doc.members.filter((row) => row.id !== player.id);
    delete index.byPlayer[player.id];
    indexDirty = true;
    touchDoc(doc);
    commit(doc);
    persistIndex();
    notifyClan(doc, "clan.notify.left", { name: player.name });
    audit("clans", "leave", player.name, `${doc.name} (лидер → ${successor.name})`);
    return { ok: true, key: "clan.left", params: { name: doc.name } };
  }
  doc.members = doc.members.filter((row) => row.id !== player.id);
  delete index.byPlayer[player.id];
  indexDirty = true;
  touchDoc(doc);
  commit(doc);
  persistIndex();
  notifyClan(doc, "clan.notify.left", { name: player.name });
  audit("clans", "leave", player.name, doc.name);
  return { ok: true, key: "clan.left", params: { name: doc.name } };
};

export const kickMember = (player: Player, targetName: string): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "kick")) return { ok: false, key: "clan.perm" };
  const target = doc.members.find((row) => row.name.toLowerCase() === targetName.trim().toLowerCase());
  if (!target) return { ok: false, key: "clan.noTarget" };
  if (target.id === player.id) return { ok: false, key: "clan.selfKick" };
  if (target.role === "leader") return { ok: false, key: "clan.kickLeader" };
  const actorRole = roleOf(doc, player.id);
  if (actorRole === "officer" && target.role === "officer") return { ok: false, key: "clan.perm" };
  doc.members = doc.members.filter((row) => row.id !== target.id);
  delete index.byPlayer[target.id];
  indexDirty = true;
  touchDoc(doc);
  commit(doc);
  persistIndex();
  notifyClan(doc, "clan.notify.kicked", { name: target.name });
  audit("clans", "kick", `${player.name}->${target.name}`, doc.name);
  return { ok: true, key: "clan.kicked", params: { name: target.name } };
};

export const setRole = (player: Player, targetName: string, role: ClanRole): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (roleOf(doc, player.id) !== "leader") return { ok: false, key: "clan.needLeader" };
  const target = doc.members.find((row) => row.name.toLowerCase() === targetName.trim().toLowerCase());
  if (!target) return { ok: false, key: "clan.noTarget" };
  if (target.role === "leader") return { ok: false, key: "clan.leadImmune" };
  if (role === "leader") {
    target.role = "leader";
    const old = memberOf(doc, player.id);
    if (old) old.role = "officer";
  } else {
    target.role = role;
  }
  touchDoc(doc);
  commit(doc);
  notifyClan(doc, "clan.notify.role", { name: target.name, role: target.role });
  audit("clans", "role", `${player.name}->${target.name}`, `${doc.name} ${target.role}`);
  return { ok: true, key: "clan.roleSet", params: { name: target.name, role: target.role } };
};

export const setBoard = (player: Player, text: string): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "board")) return { ok: false, key: "clan.perm" };
  const clean = text.replace(/[\n\r]/g, " ").trim().slice(0, CLANS.boardChars);
  doc.board = clean;
  touchDoc(doc);
  if (!commit(doc)) return { ok: false, key: "clan.storage" };
  notifyClan(doc, "clan.notify.board", { name: player.name });
  audit("clans", "board", player.name, doc.name);
  return { ok: true, key: "clan.boardSet", params: { chars: clean.length } };
};

export const setHome = (player: Player, cost: number): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "home")) return { ok: false, key: "clan.perm" };
  //先把 точку ставим в память и пробуем сохранить: плату берём только если документ
  //реально записался, иначе переполнение хранилища съело бы деньги у игрока.
  const previous = doc.home;
  doc.home = { x: player.location.x, y: player.location.y, z: player.location.z, dimensionId: player.dimension.id };
  touchDoc(doc);
  if (!commit(doc)) {
    doc.home = previous;
    touchDoc(doc);
    commit(doc);
    return { ok: false, key: "clan.storage" };
  }
  if (cost > 0) {
    const burned = burn(player, cost, "clan home");
    if (!burned.ok) {
      doc.home = previous;
      touchDoc(doc);
      commit(doc);
      return { ok: false, key: burned.key, params: burned.params };
    }
  }
  notifyClan(doc, "clan.notify.home", { name: player.name });
  audit("clans", "home", player.name, `${doc.name} ${Math.round(player.location.x)} ${Math.round(player.location.y)} ${Math.round(player.location.z)}`);
  return { ok: true, key: "clan.homeSet", params: { cost } };
};

export const teleportHome = (player: Player, cost: number): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!doc.home) return { ok: false, key: "clan.noHome" };
  const now = Date.now();
  const readyAt = doc.homeReadyAt[player.id] ?? 0;
  if (readyAt > now) return { ok: false, key: "clan.homeCooldown", params: { seconds: Math.ceil((readyAt - now) / 1000) } };
  if (cost > 0 && balance(player) < cost) {
    return { ok: false, key: "eco.balance.low", params: { need: cost, have: balance(player) } };
  }
  try {
    player.teleport(
      { x: doc.home.x, y: doc.home.y, z: doc.home.z },
      { dimension: world.getDimension(doc.home.dimensionId) },
    );
  } catch (error) {
    //телепорт не вышел — не берём деньги и не включаем кулдаун, иначе игрок заплатил
    //и остался на месте ещё и на 5 минут заперт
    log.warn("clans", `телепорт домой: ${String(error)}`);
    return { ok: false, key: "clan.homeFail" };
  }
  doc.homeReadyAt[player.id] = now + CLANS.homeCooldownMs;
  touchDoc(doc);
  commit(doc);
  let charged = 0;
  if (cost > 0) {
    const burned = burn(player, cost, "clan home tp");
    if (burned.ok) charged = cost;
  }
  return { ok: true, key: "clan.homeTp", params: { cost: charged } };
};

export const depositBank = (player: Player, amount: number): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (amount <= 0) return { ok: false, key: "clan.amount" };
  const result = depositToAccount(player, accountIdOf(doc.id), doc.name, amount);
  touchDoc(doc);
  commit(doc);
  audit("clans", "bank-in", player.name, `${doc.name} ${Math.floor(amount)}`);
  return { ok: result.ok, key: result.ok ? "clan.deposited" : result.key, params: result.params };
};

export const withdrawBank = (player: Player, amount: number): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "bank")) return { ok: false, key: "clan.perm" };
  const clean = Math.floor(amount);
  if (clean <= 0) return { ok: false, key: "clan.amount" };
  const day = Math.floor(Date.now() / DAY_MS);
  if (doc.bankDay !== day) {
    doc.bankDay = day;
    doc.bankWithdrawn = 0;
  }
  if (doc.bankWithdrawn + clean > CLANS.withdrawMaxPerDay) {
    return { ok: false, key: "clan.withdrawCap", params: { left: Math.max(0, CLANS.withdrawMaxPerDay - doc.bankWithdrawn) } };
  }
  const result = withdrawFromAccount(player, accountIdOf(doc.id), clean);
  if (!result.ok) return { ok: false, key: result.key, params: result.params };
  doc.bankWithdrawn += clean;
  touchDoc(doc);
  commit(doc);
  audit("clans", "bank-out", player.name, `${doc.name} ${clean}`);
  return { ok: true, key: "clan.withdrawn", params: { amount: clean } };
};

const escrowId = (left: string, right: string): string => `war:${[left, right].sort().join("+")}`;

export const warInfo = (): { id: string; name: string; members: number; bank: number; score: number; wars: number }[] =>
  index.clanIds
    .map((id) => loadDoc(id))
    .filter((doc): doc is ClanDoc => !!doc)
    .map((doc) => ({
      id: doc.id,
      name: doc.name,
      members: doc.members.length,
      bank: accountBalance(accountIdOf(doc.id)),
      score: doc.score,
      wars: doc.wars.filter((war) => war.endsAt > Date.now()).length,
    }));

export const declareWar = (player: Player, enemyName: string, stake: number): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "war")) return { ok: false, key: "clan.perm" };
  const enemy = warInfo().find((row) => row.name.toLowerCase() === enemyName.trim().toLowerCase());
  if (!enemy) return { ok: false, key: "clan.enemyNotFound" };
  if (enemy.id === doc.id) return { ok: false, key: "clan.enemySelf" };
  const enemyDoc = loadDoc(enemy.id);
  if (!enemyDoc) return { ok: false, key: "clan.enemyNotFound" };
  if (doc.members.length < CLANS.war.minMembers || enemyDoc.members.length < CLANS.war.minMembers) {
    return { ok: false, key: "clan.enemySmall", params: { min: CLANS.war.minMembers } };
  }
  if (doc.cooldownAt > Date.now()) return { ok: false, key: "clan.warCooldown", params: { hours: Math.ceil((doc.cooldownAt - Date.now()) / 3_600_000) } };
  if (doc.wars.some((war) => war.clanId === enemy.id && war.endsAt > Date.now())) return { ok: false, key: "clan.warActive" };
  const clean = Math.floor(stake);
  if (clean < CLANS.war.stakeMin || clean > CLANS.war.stakeMax) {
    return { ok: false, key: "clan.stakeRange", params: { min: CLANS.war.stakeMin, max: CLANS.war.stakeMax } };
  }
  const fee = Math.max(1, Math.round((clean * CLANS.war.feePercent) / 100));
  if (accountBalance(accountIdOf(doc.id)) < clean + fee) {
    return { ok: false, key: "clan.stakeLow", params: { need: clean + fee, have: accountBalance(accountIdOf(doc.id)) } };
  }
  burnAccount(accountIdOf(doc.id), fee, `war fee ${doc.name}`);
  if (!transferBetweenAccounts(accountIdOf(doc.id), escrowId(doc.id, enemy.id), clean, 0)) {
    return { ok: false, key: "clan.stakeLow", params: { need: clean, have: accountBalance(accountIdOf(doc.id)) } };
  }
  const war: ClanWar = {
    clanId: enemy.id,
    startedAt: Date.now(),
    endsAt: Date.now() + CLANS.war.durationMs,
    mine: 0,
    theirs: 0,
    stake: clean,
    matched: false,
    attack: true,
    settled: false,
  };
  doc.wars.push(war);
  enemyDoc.wars.push({ ...war, clanId: doc.id, mine: 0, theirs: 0, attack: false });
  touchDoc(doc);
  touchDoc(enemyDoc);
  commit(doc);
  commit(enemyDoc);
  notifyClan(enemyDoc, "clan.notify.warDeclare", { enemy: doc.name, stake: clean });
  notifyClan(doc, "clan.notify.warAccepted", { enemy: enemyDoc.name });
  audit("clans", "war-declare", `${doc.name}->${enemyDoc.name}`, `stake ${clean}, fee ${fee}`);
  return { ok: true, key: "clan.warDeclared", params: { enemy: enemyDoc.name, stake: clean, fee } };
};

export const acceptWar = (player: Player, enemyName: string): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  if (!canDo(doc, player.id, "war")) return { ok: false, key: "clan.perm" };
  const war = doc.wars.find((row) => {
    const other = loadDoc(row.clanId);
    return !row.matched && row.endsAt > Date.now() && (other?.name.toLowerCase() === enemyName.trim().toLowerCase() || row.clanId === enemyName.trim());
  });
  if (!war) return { ok: false, key: "clan.warNotFound" };
  const stake = war.stake;
  if (accountBalance(accountIdOf(doc.id)) < stake) return { ok: false, key: "clan.stakeLow", params: { need: stake, have: accountBalance(accountIdOf(doc.id)) } };
  if (!transferBetweenAccounts(accountIdOf(doc.id), escrowId(doc.id, war.clanId), stake, 0)) return { ok: false, key: "clan.stakeLow", params: { need: stake, have: 0 } };
  war.matched = true;
  const enemy = loadDoc(war.clanId);
  if (enemy) {
    const mirror = enemy.wars.find((row) => row.clanId === doc.id);
    if (mirror) mirror.matched = true;
    touchDoc(enemy);
    commit(enemy);
    notifyClan(enemy, `«${doc.name}» принял вызов, эскроу удвоен`);
  }
  touchDoc(doc);
  commit(doc);
  audit("clans", "war-accept", `${doc.name}<->${enemy?.name ?? war.clanId}`, `stake ${stake}`);
  return { ok: true, key: "clan.warAccepted", params: { stake } };
};

export const onPvpKill = (killer: Player, victim: Player): void => {
  const killerDoc = clanOf(killer.id);
  if (!killerDoc) return;
  const victimDoc = clanOf(victim.id);
  const member = memberOf(killerDoc, killer.id);
  if (member) {
    member.kills += 1;
    touchDoc(killerDoc);
  }
  if (!victimDoc || victimDoc.id === killerDoc.id) {
    if (member) member.points += 1;
    commit(killerDoc);
    return;
  }
  const war = killerDoc.wars.find((row) => row.clanId === victimDoc.id && row.endsAt > Date.now());
  if (!war) {
    commit(killerDoc);
    return;
  }
  war.mine += CLANS.war.pointPerKill;
  if (member) member.points += CLANS.war.pointPerKill;
  const mirror = victimDoc.wars.find((row) => row.clanId === killerDoc.id);
  if (mirror) {
    mirror.theirs += CLANS.war.pointPerKill;
    touchDoc(victimDoc);
    commit(victimDoc);
  }
  touchDoc(killerDoc);
  commit(killerDoc);
  notifyClan(killerDoc, "clan.notify.warPoint", { name: killer.name, points: CLANS.war.pointPerKill, mine: war.mine, theirs: war.theirs });
};

export const settleWars = (): number => {
  const now = Date.now();
  let settled = 0;
  for (const clanId of [...index.clanIds]) {
    const doc = loadDoc(clanId);
    if (!doc) continue;
    const finished = doc.wars.filter((row) => row.endsAt <= now);
    if (finished.length === 0) continue;
    for (const war of finished) {
      const enemy = loadDoc(war.clanId);
      const escrow = escrowId(doc.id, war.clanId);
      const pool = accountBalance(escrow);
      const myWin = war.mine > war.theirs;
      const draw = war.mine === war.theirs;
      if (pool > 0) {
        if (draw) {
          transferBetweenAccounts(escrow, accountIdOf(doc.id), war.stake, 0);
        } else if (myWin) {
          transferBetweenAccounts(escrow, accountIdOf(doc.id), pool, 0);
        } else if (war.matched && enemy) {
          transferBetweenAccounts(escrow, accountIdOf(enemy.id), pool, 0);
        } else {
          burnAccount(escrow, pool, "war forfeit");
        }
      }
      if (!war.settled) {
        if (myWin) {
          doc.score += CLANS.war.pointBonusForWin;
          doc.wins += 1;
          if (enemy) enemy.losses += 1;
        } else if (!draw) {
          doc.losses += 1;
          if (enemy) {
            enemy.score += CLANS.war.pointBonusForWin;
            enemy.wins += 1;
          }
        }
        doc.cooldownAt = now + CLANS.war.cooldownMs;
        if (enemy) {
          enemy.cooldownAt = Math.max(enemy.cooldownAt, now + CLANS.war.cooldownMs);
          touchDoc(enemy);
          commit(enemy);
        }
        audit("clans", "war-settle", `${doc.name}<->${enemy?.name ?? war.clanId}`, `${war.mine}:${war.theirs}, эскроу ${pool}`);
      }
      settled += 1;
    }
    doc.wars = doc.wars.filter((row) => row.endsAt > now);
    touchDoc(doc);
    commit(doc);
  }
  return settled;
};

export const pruneClans = (): number => {
  const cutoff = Date.now() - CLANS.inactivityDays * DAY_MS;
  const warnCutoff = Date.now() - (CLANS.inactivityDays - 3) * DAY_MS;
  let removed = 0;
  for (const clanId of [...index.clanIds]) {
    const doc = loadDoc(clanId);
    if (!doc) {
      index.clanIds = index.clanIds.filter((row) => row !== clanId);
      indexDirty = true;
      continue;
    }
    const last = doc.members.reduce((max, member) => Math.max(max, member.lastSeen), doc.createdAt);
    if (last > warnCutoff) continue;
    if (doc.wars.some((war) => war.endsAt > Date.now())) continue;
    if (last > cutoff) {
      if (doc.warnedAt === 0) {
        doc.warnedAt = Date.now();
        touchDoc(doc);
        commit(doc);
        notifyAdmins(`[clans] «${doc.name}» неактивен ${CLANS.inactivityDays - 3} дней — удаление через 3 дня`);
        notifyClan(doc, "clan.notify.prune");
      }
      continue;
    }
    removed += 1;
    notifyAdmins(`[clans] «${doc.name}» удалён за неактивность, казна ${accountBalance(accountIdOf(doc.id))} сожжена`);
    destroyDoc(doc, "auto-prune");
  }
  if (indexDirty) persistIndex();
  return removed;
};

const destroyDoc = (doc: ClanDoc, reason: string): void => {
  for (const member of doc.members) delete index.byPlayer[member.id];
  for (const invite of doc.invites) delete index.byPlayer[invite.id];
  index.clanIds = index.clanIds.filter((row) => row !== doc.id);
  delete index.names[doc.id];
  indexDirty = true;
  docs.delete(doc.id);
  dirtyDocs.delete(doc.id);
  clearWorldJson(keyOf(doc.id));
  const bank = accountBalance(accountIdOf(doc.id));
  if (bank > 0) burnAccount(accountIdOf(doc.id), bank, `clan disbanded (${reason})`);
  audit("clans", "disband", doc.name, reason);
};

export const disbandClan = (player: Player, allowLeaderless: boolean): ClanResult => {
  const doc = clanOf(player.id);
  if (!doc) return { ok: false, key: "clan.none" };
  const role = roleOf(doc, player.id);
  if (role !== "leader" && !allowLeaderless) return { ok: false, key: "clan.needLeader" };
  const name = doc.name;
  destroyDoc(doc, `роспуск от ${player.name}`);
  persistIndex();
  return { ok: true, key: "clan.disbanded", params: { name } };
};

export const forceDisband = (actor: string, clanId: string): ClanResult => {
  const doc = loadDoc(clanId);
  if (!doc) return { ok: false, key: "clan.noClan" };
  const name = doc.name;
  const members = [...doc.members];
  destroyDoc(doc, `админ ${actor}`);
  persistIndex();
  for (const member of members) {
    const player = findByName(member.name);
    if (!player) continue;
    try {
      player.sendMessage(`клан «${name}» расформирован админом`);
    } catch {
      continue;
    }
  }
  return { ok: true, key: "clan.disbanded", params: { name } };
};

export const clanLeaderboard = (viewer: Player, limit: number): string[] => {
  const rows = warInfo().sort((left, right) => right.score - left.score || right.members - left.members).slice(0, clamp(limit, 1, 25));
  if (rows.length === 0) return [t(viewer, "clan.leader.empty")];
  return rows.map((row, position) =>
    t(viewer, "clan.leader.line", { pos: position + 1, name: row.name, score: row.score, members: row.members, bank: row.bank }),
  );
};

export const clanNames = (): string[] => index.clanIds.map((id) => index.names[id] ?? id);

export const storageReport = (): string[] => {
  const sizes = index.clanIds
    .map((id) => ({ id, name: index.names[id] ?? id, bytes: (() => {
      const doc = loadDoc(id);
      return doc ? JSON.stringify(doc).length : -1;
    })() }))
    .sort((left, right) => right.bytes - left.bytes);
  const overBudget = sizes.filter((row) => row.bytes > CLANS.storage.perClanBudgetBytes).length;
  const used = dynamicPropertyBudget();
  const percent = used < 0 ? 0 : Math.round((used / CLANS.storage.totalBudgetBytes) * 100);
  const lines = [
    `кланов: ${index.clanIds.length}/${CLANS.storage.maxClans}, размер индекса: ${JSON.stringify(index).length}/${CLANS.storage.indexBudgetBytes} байт`,
    `dynamic properties мира: ${used} байт из ${CLANS.storage.totalBudgetBytes} (${percent}%)`,
    `документов сверх бюджета: ${overBudget}, кэш: ${docs.size}/${CACHE_LIMIT}`,
    `лимит участников: ${getTunables().clanMaxMembers}`,
  ];
  for (const row of sizes.slice(0, 8)) {
    lines.push(`  ${row.name}: ${row.bytes < 0 ? "нет файла" : `${row.bytes} байт`}`);
  }
  if (percent > CLANS.storage.warnPercent) {
    lines.push(`внимание: хранилище заполнено на ${percent}% — сократи составы или удали кланы`);
  }
  return lines;
};

export const flushClans = (): number => {
  let written = 0;
  for (const clanId of [...dirtyDocs]) {
    const doc = docs.get(clanId) ?? loadDoc(clanId);
    if (!doc) {
      dirtyDocs.delete(clanId);
      continue;
    }
    if (saveDoc(doc)) written += 1;
  }
  if (indexDirty) persistIndex();
  return written;
};

export const syncMembers = (): number => {
  const online = world.getAllPlayers();
  const byId = new Map<string, Player>();
  for (const player of online) byId.set(player.id, player);
  let changed = 0;
  for (const clanId of index.clanIds) {
    const doc = loadDoc(clanId);
    if (!doc) continue;
    let dirty = false;
    for (const member of doc.members) {
      const player = byId.get(member.id);
      if (!player) continue;
      if (member.name !== player.name) {
        member.name = player.name;
        dirty = true;
      }
      if (Date.now() - member.lastSeen > 300_000) {
        member.lastSeen = Date.now();
        dirty = true;
      }
    }
    if (dirty) {
      changed += 1;
      touchDoc(doc);
      if (dirtyDocs.size >= CACHE_LIMIT) flushClans();
    }
  }
  return changed;
};

const notifyClan = (doc: ClanDoc, key: string, params?: Record<string, string | number>): void => {
  for (const member of doc.members) {
    const player = findByName(member.name);
    if (!player) continue;
    try {
      player.sendMessage(t(player, "clan.notify", { tag: doc.tag, text: t(player, key, params) }));
    } catch {
      continue;
    }
  }
};

export const clanCacheStats = (): { docs: number; dirty: number; clans: number } => ({
  docs: docs.size,
  dirty: dirtyDocs.size,
  clans: index.clanIds.length,
});

export const findClanByName = (name: string): ClanDoc | undefined => {
  const lowered = name.trim().toLowerCase();
  for (const clanId of index.clanIds) {
    if ((index.names[clanId] ?? "").toLowerCase() !== lowered) continue;
    return loadDoc(clanId);
  }
  return undefined;
};

export const invitesFor = (player: Player): string[] => {
  const lines: string[] = [];
  for (const clanId of index.clanIds) {
    const doc = loadDoc(clanId);
    if (!doc) continue;
    const invite = doc.invites.find((row) => row.id === player.id);
    if (!invite) continue;
    const minutes = Math.max(0, Math.round((CLANS.inviteTtlMs - (Date.now() - invite.at)) / 60000));
    lines.push(t(player, "clan.invite.line", { name: doc.name, tag: doc.tag, by: invite.by, minutes }));
  }
  return lines;
};
