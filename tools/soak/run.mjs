/**
 * Soak/fuzz-прогон: много игроков, случайные действия, инварианты после каждого раунда.
 *
 * Отличие от `tools/stability/run.mjs`: там сценарии рукописные и проверяют «работает ли
 * фича», здесь — «не ломается ли состояние сервера при беспорядочном потоке». Проверки
 * поэтому инварианты (консервация монет, schema кошелька, отсутствие призраков в памяти,
 * отсутствие сырых ключей в тексте, неизменность blueprint'а), а не конкретные строки.
 *
 * Запуск: npm run soak            (детерминированно, SEED=20261113)
 *         SOAK_SEED=7 SOAK_PLAYERS=24 SOAK_ROUNDS=400 npm run soak
 * Выход != 0, если найдено хоть одно нарушение.
 */
import * as mc from "../stability/mock-server.mjs";
import { ui } from "../stability/mock-ui.mjs";

// ──────────────────────────────────────────────────────────────────────────────
// 0. Входные параметры и ГПСЧ (детерминизм важнее «случайности»: провал должен
//    воспроизводиться по тому же сиду)
// ──────────────────────────────────────────────────────────────────────────────
const SEED = Number(process.env.SOAK_SEED ?? 20261113);
const PLAYER_COUNT = Number(process.env.SOAK_PLAYERS ?? 14);
const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 140);
const VERBOSE = Boolean(process.env.SOAK_VERBOSE);
const log = console.log.bind(console);

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry32(SEED);
const rand = (n) => Math.floor(rng() * Math.max(1, n));
const pick = (rows) => rows[rand(rows.length)];
const chance = (p) => rng() < p;
const between = (min, max) => min + rand(max - min + 1);

const errors = [];
const warns = [];
console.log = (line) => {
  if (typeof line === "string" && line.includes("][error]")) errors.push(line);
  if (typeof line === "string" && line.includes("][warn]")) warns.push(line);
  if (VERBOSE) log(line);
};
console.error = (line) => {
  errors.push(String(line));
  if (VERBOSE) log("[stderr]", line);
};
console.warn = (line) => {
  warns.push(String(line));
  if (VERBOSE) log("[warn]", line);
};

const findings = [];
const seen = new Set();
/** @param kind — что именно нарушено; detail — контекст. Дедуп по kind+detail. */
const report = (round, kind, detail) => {
  const id = `${kind}::${String(detail).slice(0, 160)}`;
  if (seen.has(id)) return;
  seen.add(id);
  findings.push({ round, kind, detail: String(detail) });
};

// ──────────────────────────────────────────────────────────────────────────────
// 1. Бут и команды — как в стаб-прогоне
// ──────────────────────────────────────────────────────────────────────────────
const commands = new Map();
await import("../stability/.build/bundle.mjs");
mc.fire("system:before", "startup", {
  customCommandRegistry: {
    registerCommand: (spec, handler) => commands.set(spec.name, { spec, handler }),
    registerEnum: () => undefined,
  },
  blockComponentRegistry: {},
  itemComponentRegistry: {},
  dimensionRegistry: {},
});
mc.fire("after", "worldLoad", {});
mc.tickTimes(6);

const NAMES = [
  "Alice", "Bob", "Carl", "Dora", "Eve", "Finn", "Gus", "Hana", "Igor", "Jade",
  "Kira", "Lars", "Mira", "Nils", "Ola", "Piet", "Rosa", "Sven", "Tara", "Ulf",
  "Vera", "Wes", "Xena", "Yuri", "Zoe", "Ada", "Bram", "Cleo", "Devi", "Enzo",
];
const ADMIN = "Admin";

const runCmd = (name, player, ...args) => {
  const entry = commands.get(name);
  if (!entry) return undefined;
  try {
    const value = entry.handler({ sourceType: "Entity", sourceEntity: player }, ...args);
    // синхронный ответ уходит в CustomCommandResult.message и двигателем режется молча;
    // clip() обязан уложить его в лимит по границе строки — ровно 900 значит «хвост потерян»
    const message = typeof value === "string" ? value : String(value?.message ?? "");
    if (message.length >= 900) {
      report(roundNow, "ответ команды упёрся в лимит сообщения", `${name} ${args.join(" ")}: ${message.length} символов`);
    }
    if (value && typeof value.then === "function") {
      // async-обработчики: ошибки ловим сами, иначе «unhandled» уйдёт в stderr между раундами
      void value.then(
        () => undefined,
        (error) => errors.push(`[unhandled] ${name}: ${String(error?.message ?? error)}`),
      );
    }
    return value;
  } catch (error) {
    report(roundNow, "исключение команды", `${name} ${args.join(" ")} → ${String(error?.message ?? error)}`);
    return undefined;
  }
};
const settle = (ticks = 6) => mc.tickTimes(ticks);
/** дождаться microtask-очередей: async-обработчики команд и show() форм доезжают только так */
const drain = async (times = 3) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
/** временное переключение с политики на явную очередь ответов (mint через админ-форму) */
const withAnswers = async (values, fn) => {
  const policy = ui.policy;
  ui.policy = undefined;
  ui.answers.length = 0;
  ui.answers.push(...values);
  try {
    const result = await fn();
    await drain();
    return result;
  } finally {
    ui.answers.length = 0;
    ui.policy = policy;
  }
};
const flushAll = () => runCmd("sw:meta", admin, "flush");
const readJson = (key) => {
  const count = mc.world.getDynamicProperty(`${key}:n`);
  if (typeof count !== "number" || count <= 0) return undefined;
  let text = "";
  for (let index = 0; index < count; index += 1) {
    const part = mc.world.getDynamicProperty(`${key}:${index}`);
    if (typeof part !== "string") return undefined;
    text += part;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { __broken: text.slice(0, 80) };
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// 2. Игроки
// ──────────────────────────────────────────────────────────────────────────────
const admin = mc.state.players.find((row) => row.name === ADMIN) ?? mc.makePlayer("p-admin", ADMIN, { x: 0, y: 71, z: 0 });
admin.addTag("admin");

/** запись на игрока: объект mc + его собственный счётчик форм и «чего я жду» */
const roster = [];
const spawnRoster = (count) => {
  for (let index = 0; index < count; index += 1) {
    const name = NAMES[index % NAMES.length];
    const id = `p-s${index}`;
    const inside = index % 3 !== 0;
    const location = inside
      ? { x: between(-14, 14) + 0.5, y: 81, z: between(-14, 14) + 0.5 }
      : { x: between(40, 120) + 0.5, y: 71, z: between(-120, -40) + 0.5 };
    everCreated.add(id);
    const player = mc.makePlayer(id, name, location);
    if (index % 5 === 0) player.addTag("admin");
    const isAdmin = index % 5 === 0;
    player.clientSystemInfo.locale = index % 2 === 0 ? "ru_RU" : "en_US";
    roster.push({ player, id, name, forms: 0, minted: 0, quarantine: 0, left: false, admin: isAdmin });
  }
};
const byId = (id) => roster.find((row) => row.id === id);
/** все id, которые вообще существовали: кошелёк оффлайн-игрока обязан жить */
const everCreated = new Set(["p-admin"]);

// ──────────────────────────────────────────────────────────────────────────────
// 3. Политика ответов на формы (замена глобальной очереди ответов)
// ──────────────────────────────────────────────────────────────────────────────
const DEEP_LABELS = [
  "Кейс", "Кейсы", "Ранги", "Рынок", "Кошелёк", "Клан", "Прогресс", "Донат", "Магазин",
  "Космет", "Рефер", "Тотем", "Карьер", "Спавн", "Моды", "Эконом", "Мета", "Админ",
  "Начислить", "Открыть", "Купить", "Продать", "Крутить", "Список",
];
const HOSTILE = [
  "", " ", "  ", "0", "-1", "999999999", "1e30", "NaN", "null", "undefined", "true",
  "Alice", "admin", "*", "§4x", "%%%", "{count}", "{{x}}", "<script>alert(1)</script>",
  "a".repeat(400), "🔥".repeat(40), "‮", "\u0000", "x\ny", "' OR 1=1 --", "../../../etc/passwd",
  "4294967296", "-0.5", "1,5", "1 2", "  Alice  ", "Админ", "1000000000000000000000",
];
const modalValue = (control) => {
  if (!control) return "";
  if (control.type === "dropdown") return chance(0.1) ? control.options.length + 2 : rand(Math.max(1, control.options.length));
  if (control.type === "slider") return String(between(Number(control.min ?? 0), Number(control.max ?? 10)));
  if (control.type === "toggle") return chance(0.5);
  return chance(0.45) ? pick(HOSTILE) : chance(0.5) ? String(between(0, 3000)) : pick(NAMES);
};

let formsInRound = 0;
ui.policy = (record) => {
  formsInRound += 1;
  const row = roster.find((entry) => entry.player.name === record.player);
  if (!row || formsInRound > 90 || row.forms > 4 || chance(0.14)) return "cancel";
  row.forms += 1;
  if (record.kind === "message") return chance(0.5) ? 0 : 1;
  if (record.kind === "modal") return record.controls.map((control) => modalValue(control));
  const labels = record.buttons ?? [];
  if (labels.length === 0) return "cancel";
  if (chance(0.55)) {
    const wanted = labels.findIndex((label) => DEEP_LABELS.some((part) => label.includes(part)));
    if (wanted >= 0) return wanted;
  }
  return rand(labels.length);
};

// ──────────────────────────────────────────────────────────────────────────────
// 4. Действия
// ──────────────────────────────────────────────────────────────────────────────
const CMD_ARGS = {
  "sw:menu": [[]],
  "sw:rtp": [[], ["now"]],
  "sw:case": [[], ["open"], ["open", "1"], ["open", "3"], ["open", "99"], ["open", "-1"], ["keys"], ["odds"], ["rank"], ["rank", "open"], ["rank", "open", "5"], ["rank", "odds"], ["nope"]],
  "sw:rank": [[], ["info"], ["roll"], ["roll", "2"], ["roll", "abc"], ["give", "myth"], ["give", "nope"], ["give"], ["nope"]],
  "sw:market": [[], ["add", "5", "10"], ["set", "1", "7"], ["buy", "1"], ["buy", "0"], ["buy", "999999"], ["mine"], ["nope"]],
  "sw:eco": [["balance"], ["pay", "Bob", "10"], ["pay", "Bob", "-5"], ["pay", "Nobody", "10"], ["pay", "Alice", "abc"], ["top"], ["nope"]],
  "sw:clan": [[], ["create", "Gildia"], ["create", "x"], ["invite", "Bob"], ["kick", "Bob"], ["join", "Gildia"], ["leave"], ["home"], ["tp"], ["disband"], ["status"], ["nope"]],
  "sw:shop": [[], ["coins", "1"], ["coins", "999999"], ["keys", "2"], ["nope"]],
  "sw:don": [["redeem", "GIFT-ALICE-1"], ["redeem", "GIFT-BOB-1"], ["redeem", "NOPE"], ["redeem"], ["history"], ["nope"]],
  "sw:ref": [["code"], ["bind", "ZZZZZZ"], ["bind", "ABCDEF"], ["bind", "ABCDEF"], ["list"], ["nope"]],
  "sw:quest": [[], ["daily"], ["nope"]],
  "sw:quarry": [[], ["status"], ["list"], ["start"], ["collect"], ["collect", "1"], ["collect", "999999"], ["close"], ["go"], ["nope"]],
  "sw:totem": [[], ["how"], ["forge", "1"], ["forge", "3"], ["revoke", "1"], ["revoke", "abc"], ["nope"]],
  "sw:spawn": [[], ["status"], ["build"], ["preview"], ["check"], ["set"], ["nope"]],
  "sw:hud": [["on"], ["off"], ["status"], ["rows"], ["sidebar"], ["nope"], []],
  "sw:admin": [[], ["nope"]],
  "sw:ac": [["reset"], ["nope"], []],
  "sw:event": [["list"], ["status"], ["start", "koth"], ["stop"], ["nope"], []],
  "sw:meta": [["status"], ["flush"], ["nope"], []],
};
const ALL_CMDS = Object.keys(CMD_ARGS);

const actions = {
  menu: async (row) => {
    row.player.sendMessage("/sw:menu");
    await runCmd("sw:menu", row.player);
    for (let depth = 0; depth < 3; depth += 1) await drain();
  },
  commands: async (row) => {
    const name = pick(ALL_CMDS);
    const args = pick(CMD_ARGS[name] ?? [[]]);
    await runCmd(name, row.player, ...args);
  },
  adminCommands: async (row) => {
    // не-админ не должен сдвинуть ни один тумблер — сверяем отпечаток хранилища ДО и ПОСЛЕ
    if (!row.admin) {
      const fingerprint = JSON.stringify(readJson("sw:eco:cfg") ?? {}) + JSON.stringify(readJson("sw:ac:cfg") ?? {});
      await runCmd("sw:meta", row.player, "set", "mintPerKey", "0");
      await runCmd("sw:meta", row.player, "set", "ranksEnabled", "false");
      await runCmd("sw:ac", row.player, "param", "threshold", "999");
      settle(2);
      if (JSON.stringify(readJson("sw:eco:cfg") ?? {}) + JSON.stringify(readJson("sw:ac:cfg") ?? {}) !== fingerprint) {
        report(roundNow, "не-админ изменил конфиг", `${row.name}: ${fingerprint.slice(0, 80)}`);
      }
      return;
    }
    const path = pick(["queueEnabled", "donorTrailsEnabled", "quarryEnabled", "totemsEnabled", "spawnProtectEnabled", "ranksEnabled", "hudBarEnabled", "hudSidebarEnabled", "mintPerKey", "casePrice", "sellMultiplier", "transferTaxPercent"]);
    const value = pick(["0", "1", "true", "false", "-5", "999999", "abc", ""]);
    await runCmd("sw:meta", row.player, "set", path, value);
  },
  breakSpawn: async (row) => {
    const spot = { x: between(-6, 6), y: 79, z: between(-6, 6) };
    const result = mc.breakBlock(row.player, spot);
    if (isProtectOn() && !result.cancelled && !nearBuild(row.player)) {
      report(roundNow, "защита спавна пропускает ломку", `${row.name} сломал ${spot.x},${spot.y},${spot.z} (отмена=${result.cancelled})`);
    }
  },
  placeSpawn: async (row) => {
    const spot = { x: between(-8, 8), y: 80, z: between(-8, 8) };
    mc.placeBlock(row.player, spot, pick(["minecraft:cobblestone", "minecraft:tnt", "minecraft:water", "minecraft:lava", "minecraft:bedrock"]));
    settle(2);
  },
  digWild: async (row) => {
    for (let index = 0; index < between(1, 6); index += 1) {
      mc.breakBlock(row.player, { x: between(60, 200), y: between(50, 66), z: between(-200, -60) });
    }
  },
  blast: async (row) => {
    const at = chance(0.6) ? { x: between(-10, 10), y: 79, z: between(-10, 10) } : { x: between(60, 160), y: 70, z: between(-160, -60) };
    const result = mc.explode(at, { source: row.player });
    if (isProtectOn()) {
      const leaked = result.destroyed.filter((cell) => insideLobby(cell));
      if (leaked.length > 0) report(roundNow, "взрыв снёс клетки на спавне", `${leaked.length} шт, источник ${row.name}`);
    }
  },
  buckets: async (row) => {
    for (const item of ["minecraft:water_bucket", "minecraft:lava_bucket", "minecraft:bucket", "minecraft:flint_and_steel"]) {
      mc.useItem(row.player, new mc.ItemStack(item, 1));
    }
  },
  fight: async (row) => {
    const other = pick(roster);
    if (!other || other === row) return;
    mc.fire("before", "entityHurt", { hurtEntity: other.player, damageSource: { cause: "entityAttack", damagingEntity: row.player }, damage: between(1, 40), cancel: false });
    mc.fire("after", "entityHurt", { hurtEntity: other.player, damageSource: { cause: "entityAttack", damagingEntity: row.player }, damage: between(1, 40) });
    if (chance(0.4)) mc.fire("after", "entityHitEntity", { damagingEntity: row.player, hurtEntity: other.player, damage: 7 });
  },
  die: async (row) => {
    mc.fire("after", "entityDie", { deadEntity: row.player, damageSource: { cause: pick(["fall", "lava", "entityAttack", "void", "drowning"]) } });
    row.player.teleport({ x: 0.5, y: 81, z: 0.5 });
    mc.fire("after", "playerSpawn", { player: row.player, initialSpawn: false });
  },
  churn: async (row) => {
    if (roster.length <= 6) return;
    if (row.quarantine > 0) {
      row.quarantine -= 1;
      return;
    }
    if (chance(0.5)) {
      mc.removePlayer(row.player);
      row.left = true;
      row.quarantine = 1;
      return;
    }
    if (row.left) {
      row.left = false;
      const revived = mc.makePlayer(row.id, row.name, row.player.location);
      if (roster[0] === row) revived.addTag("admin");
      row.player = revived;
    }
  },
  move: async (row) => {
    const target = chance(0.45) ? { x: between(-20, 20) + 0.5, y: 81, z: between(-20, 20) + 0.5 } : { x: between(-250, 250) + 0.5, y: between(64, 90), z: between(-250, 250) + 0.5 };
    row.player.teleport(target);
    mc.fire("after", "playerSpawn", { player: row.player, initialSpawn: false });
  },
  interact: async (row) => {
    const event = { player: row.player, block: mc.world.getDimension("minecraft:overworld").getBlock({ x: 0, y: 81, z: 0 }), relativeClickPosition: { x: 0.5, y: 0.5, z: 0.5 }, itemStack: undefined, cancel: false };
    mc.fire("before", "playerInteractWithBlock", event);
  },
  pickup: async (row) => {
    mc.fire("after", "entityItemPickup", { entity: row.player, itemStack: new mc.ItemStack(pick(["minecraft:diamond", "minecraft:gold_ingot", "minecraft:emerald", "minecraft:netherite_scrap"]), between(1, 12)) });
    mc.fire("after", "entityItemDrop", { entity: row.player, itemStack: new mc.ItemStack("minecraft:dirt", between(1, 8)), thrower: row.player });
  },
  mint: async (row) => {
    // «донат» через админ-форму: единственный реальный путь начисления ₡ в моке
    const amount = pick(["100", "1000", "2400", "5000", "100000"]);
    await withAnswers(
      [
        (form) => press(form, "Мета"),
        (form) => press(form, "Экономика"),
        (form) => press(form, "Начислить"),
        (form) => fill(form, [row.name, true, amount, "soak-fund"]),
      ],
      () => runCmd("sw:admin", admin),
    );
    row.minted += Number(amount) || 0;
  },
  timeWarp: async () => {
    mc.advance(between(1, 30) * 60_000);
    if (chance(0.35)) mc.advance(24 * 60 * 60_000);
    if (chance(0.3)) mc.world.setTimeOfDay(between(0, 23_000));
  },
  restart: async () => {
    flushAll();
    settle(4);
    const before = snapshotState();
    mc.fire("after", "worldLoad", {});
    settle(40);
    const after = snapshotState();
    for (const key of Object.keys(before.wallets)) {
      const left = JSON.stringify(before.wallets[key] ?? null);
      const right = JSON.stringify(after.wallets[key] ?? null);
      if (left !== right && !changedByActions.has(key)) {
        report(roundNow, "рестарт не пережил round-trip", `${key}: ${left?.slice(0, 90)} → ${right?.slice(0, 90)}`);
      }
    }
    const leftBlueprint = JSON.stringify(before.blueprint);
    const rightBlueprint = JSON.stringify(after.blueprint);
    if (leftBlueprint !== rightBlueprint) report(roundNow, "blueprint спавна изменился после рестарта", `${leftBlueprint} → ${rightBlueprint}`);
    if (after.intervals < before.intervals) report(roundNow, "после повторного worldLoad таймеров меньше", `${before.intervals} → ${after.intervals}`);
    intervalsAfterReload.push(after.intervals);
  },
  toggles: async () => {
    for (const path of ["spawnProtectEnabled", "ranksEnabled", "hudBarEnabled", "hudSidebarEnabled", "quarryEnabled", "totemsEnabled"]) {
      if (!chance(0.45)) continue;
      await runCmd("sw:meta", admin, "set", path, pick(["true", "false"]));
    }
    settle(4);
  },
};
/**
 * Живой кошелёк из кэша модуля: readJson("sw:eco:meta") — это СОХРАНЁННОЕ состояние, и
 * сравнение «до/после» по нему ловило бы такт автосейва, а не поведение приложения.
 */
const walletOf = (id) => {
  const row = roster.find((entry) => entry.id === id);
  const live = row && !row.left ? probe.economy?.metaOf?.(row.player) : undefined;
  return live ?? (readJson("sw:eco:meta") ?? {})[id] ?? {};
};
const priceOf = (label) => Number(String(label).match(/([\d ]+)\s*₡/)?.[1]?.replace(/\s/g, "") ?? 0);

/** значения для ModalFormData: «как игрок, который хотел купить, а не сломать форму» */
const validModal = (form) =>
  (form.controls ?? []).map((control) => {
    if (!control) return "";
    if (control.type === "dropdown") return 0;
    if (control.type === "slider") return Number(control.max ?? 1);
    if (control.type === "toggle") return true;
    return "";
  });

/** цепочка кнопок от sw:menu до нужного экрана (ответы кладём в очередь, не в политику) */
const walkMenu = async (row, labels) => {
  const before = ui.shown.length;
  let stepIndex = 0;
  const previous = ui.policy;
  // Ответы отдаёт ПОЛИТИКА, а не очередь `ui.answers`: очередь глобальна и съезжает на
  // шаг, если в середине пути всплывает посторонняя форма (подтверждение ивента, баннер
  // очереди). Политика видит именно ту форму, которую показывают, и именно того игрока,
  // которого мы ведём; чужим формам отдаём ход прежней (случайной) политике.
  ui.policy = (record) => {
    if (record.player !== row.player.name) return previous ? previous(record) : "cancel";
    if (record.kind === "message") return 0;
    if (record.kind === "modal") return validModal(record);
    const label = labels[stepIndex];
    stepIndex += 1;
    if (label === undefined) return "cancel";
    // метку можно задать списком: треть ростера говорит по-английски, и «Кейсы» там — «Cases».
    // Молчаливый cancel на нерусской кнопке означал бы, что весь путь не проверяется для
    // половины игроков, а аудиты радостно рапортуют «нарушений нет»
    const parts = Array.isArray(label) ? label : [label];
    const index = (record.buttons ?? []).findIndex((text) => parts.some((part) => text.includes(part)));
    return index < 0 ? "cancel" : index;
  };
  try {
    await runCmd("sw:menu", row.player);
    await drain();
    await settle(between(4, 14));
    await drain();
  } finally {
    ui.policy = previous;
  }
  return ui.shown.slice(before);
};

actions.caseRush = async (row) => {
  const CASE = ["Базовый", "Basic"];
  const matches = (text, parts) => parts.some((part) => String(text ?? "").includes(part));
  const screens = await walkMenu(row, [["Кейсы", "Cases"], CASE]);
  const caseScreen = screens.find((record) => (record.buttons ?? []).some((label) => matches(label, CASE)));
  if (!caseScreen) return;
  const price = priceOf((caseScreen.buttons ?? []).find((text) => matches(text, CASE)));
  // без монет экран честно откажет — и проверка «цена = списание» повиснет в вакууме,
  // поэтому путь финансируем явно
  if (price > 0 && Number(walletOf(row.id).coins ?? 0) < price + 500) await actions.mint(row);
  const was = walletOf(row.id);
  const wasPulls = Number(probe.economy?.metaOf?.(row.player)?.casePulls ?? 0);
  // «Кейсы → Базовый» только открывает экран кейса; монеты списывает третье нажатие
  await walkMenu(row, [["Кейсы", "Cases"], CASE, ["Открыть за монеты", "Open with coins"]]);
  const now = walletOf(row.id);
  const nowPulls = Number(probe.economy?.metaOf?.(row.player)?.casePulls ?? 0);
  if (nowPulls > wasPulls) reached.cases = Math.max(reached.cases, nowPulls);
  if (price > 0 && Number(was.coins ?? 0) >= price && nowPulls === wasPulls) {
    // пустой результат при деньгах — не «игрок отменил», а сломанный путь: либо метка кнопки
    // уехала (новый язык/переформулировка), либо списание не доходит до кошелька
    report(roundNow, "пуск кейса не дошёл до состояния", `${row.id}: списано ${Number(was.coins ?? 0) - Number(now.coins ?? 0)}, круток ${wasPulls} → ${nowPulls}`);
  }
  const spent = Number(was.coins ?? 0) - Number(now.coins ?? 0);
  const keysUsed = Number(was.caseKeys ?? 0) - Number(now.caseKeys ?? 0);
  if (spent < 0 || keysUsed < 0) report(roundNow, "кейс начислил монеты/ключи при открытии", `${row.name}: ${spent} / ${keysUsed}`);
  if (spent > 0 && keysUsed > 0) report(roundNow, "кейс взял и монеты, и ключ", `${row.name}: ${spent} ₡ + ${keysUsed} ключ(ей)`);
  // списано БОЛЬШЕ объявленной цены — объяснения «прилетели монеты из карьера» не бывает,
  // поэтому это нарушение всегда настоящее. Недобор же легко объясняется сторонним доходом
  // за те же такты, поэтому его требуем только у игрока без активного карьера
  if (spent > 0 && price > 0 && spent > price) {
    report(roundNow, "кейс списал больше объявленной цены", `${row.name}: списано ${spent}, на кнопке ${price}`);
  }
  if (spent > 0 && price > 0 && spent < price && !probe.quarry?.findQuarry?.(row.id)) {
    report(roundNow, "кейс списал меньше объявленной цены", `${row.name}: списано ${spent}, на кнопке ${price}`);
  }
  if (Number(now.caseKeys ?? 0) < 0) report(roundNow, "отрицательные ключи", `${row.name}: ${now.caseKeys}`);
};

actions.shopBuy = async (row) => {
  const screens = await walkMenu(row, [["Косметика", "Cosmetics"]]);
  const shop = screens.at(-1);
  const label = (shop?.buttons ?? []).find((text) => /₡/.test(text) && !text.includes("Крутить"));
  if (!label) return;
  const price = priceOf(label);
  const part = label.split("·")[0].trim();
  const was = walletOf(row.id);
  const confirm = ui.answers.length;
  await walkMenu(row, [["Косметика", "Cosmetics"], part, ["Да", "Yes", "Куплю", "Buy"]]);
  void confirm;
  const now = walletOf(row.id);
  const cosmetics = now.cosmetics ?? {};
  const owned = Array.isArray(cosmetics.owned) ? cosmetics.owned : [];
  const equipped = cosmetics.equipped ?? {};
  void 0;
  const spent = Number(was.coins ?? 0) - Number(now.coins ?? 0);
  if (spent < 0) report(roundNow, "покупка косметики начислила монеты", `${row.name}: +${-spent}`);
  if (spent > 0 && owned.length === 0) report(roundNow, "монеты списаны, а косметики нет", `${row.name}: ${spent} ₡, owned пуст`);
  if (spent > price + 1) report(roundNow, "косметика дороже объявленного", `${row.name}: ${spent} > ${price}`);
  for (const slot of ["prefix", "suffix", "trail", "join"]) {
    const value = equipped[slot] ?? now[`equipped${slot[0].toUpperCase()}${slot.slice(1)}`];
    if (typeof value === "string" && value.length > 0 && !owned.includes(value) && value !== "none") {
      report(roundNow, "экипирован непрокупленный предмет", `${row.name}: ${slot}=${value}, owned ${owned.join(",") || "∅"}`);
    }
  }
};

actions.questTwice = async (row) => {
  const screens = await walkMenu(row, ["Квесты"]);
  const button = (screens.at(-1)?.buttons ?? []).find((text) => /Забрать/.test(text));
  if (!button) return;
  await walkMenu(row, ["Квесты", "Забрать"]);
  const between = Number(walletOf(row.id).coins ?? 0);
  await walkMenu(row, ["Квесты", "Забрать"]);
  const after = Number(walletOf(row.id).coins ?? 0);
  if (after > between) {
    report(roundNow, "ежедневная награда выдана дважды за сутки", `${row.name}: +${after - between} ₡ со второго нажатия`);
  }
};

actions.marketSell = async (row) => {
  const container = row.player.getComponent("minecraft:inventory").container;
  container.setItem(0, new mc.ItemStack("minecraft:diamond", between(1, 5)));
  await withAnswers([(form) => press(form, "Продержать")], () => runCmd("sw:eco", row.player));
  await settle(4);
  await walkMenu(row, ["Рынок", "Выставить"]);
  const listings = readJson("sw:market");
  const rows = Array.isArray(listings?.rows ?? listings) ? (listings.rows ?? listings) : [];
  reached.marketListings = Math.max(reached.marketListings, rows.length);
  if (rows.length > 400) report(roundNow, "рынок не ограничен", `${rows.length} лотов`);
  const ids = new Set();
  for (const entry of rows) {
    const id = entry?.id ?? entry?.key;
    if (id === undefined) continue;
    if (ids.has(id)) report(roundNow, "дубликат id лота", String(id));
    ids.add(id);
    if (Number(entry?.price ?? 0) < 0 || !Number.isFinite(Number(entry?.price))) {
      report(roundNow, "некорректная цена лота", JSON.stringify(entry).slice(0, 120));
    }
  }
};

actions.acBurst = async (row) => {
  // читеры: пачка лома/установки и быстрые перемещения в одном окне — античит обязан
  // наказать, но не устроить волну киков и не накрутить скор за пределы
  const base = { x: between(120, 180), y: 64, z: between(-180, -120) };
  row.player.teleport({ x: base.x + 0.5, y: base.y + 1, z: base.z + 0.5 });
  for (let index = 0; index < 25; index += 1) {
    mc.breakBlock(row.player, base);
  }
  {
    // скор читаем сразу, до ближайшего тика: затухание + timeWarp обнуляют его между
    // раундами, и проверка на границах меряла бы расписание, а не детектор
    const acOn = probe.anticheat?.getAcConfig?.().enabled !== false;
    // playerScore принимает id, а не Player; grace-окно (служебная правка блоков админом)
    // законно обнуляет реакцию — в этом окне требовать скор нельзя
    const score = Number(probe.anticheat?.playerScore?.(row.id) ?? 0);
    const grace = Number(probe.anticheat?.graceLeftMs?.(row.id) ?? 0);
    if (acOn && grace === 0) {
      reached.acScore = Math.max(reached.acScore, 1);
      if (!(score > 0)) report(roundNow, "античит не отреагировал на 25 ломаний в одной клетке", `${row.id}: score ${score}`);
      if (score > 100) report(roundNow, "скоринг выше 100 сразу после всплеска", `${row.id}: ${score}`);
    }
  }
  for (let index = 0; index < 18; index += 1) {
    mc.placeBlock(row.player, { x: base.x, y: base.y + 1 + index, z: base.z }, "minecraft:cobblestone");
  }
  for (let index = 0; index < 8; index += 1) {
    row.player.teleport({ x: base.x + index * 40, y: 64, z: base.z - index * 40 });
    mc.fire("after", "playerSpawn", { player: row.player, initialSpawn: false });
  }
  const other = pick(roster);
  if (other && other !== row) {
    for (let index = 0; index < 15; index += 1) {
      mc.fire("before", "entityHurt", { hurtEntity: other.player, damageSource: { cause: "entityAttack", damagingEntity: row.player }, damage: 2, cancel: false });
      mc.fire("after", "entityHurt", { hurtEntity: other.player, damageSource: { cause: "entityAttack", damagingEntity: row.player }, damage: 2 });
    }
  }
  settle(2);
};

actions.totemForge = async (row) => {
  const container = row.player.getComponent("minecraft:inventory").container;
  container.setItem(row.player.selectedSlotIndex ?? 0, new mc.ItemStack("minecraft:totem_of_undying", 1));
  container.addItem(new mc.ItemStack("minecraft:emerald", 24));
  if (Number(walletOf(row.id).coins ?? 0) < 30000) await actions.mint(row);
  await walkMenu(row, [["тотемы", "totems"], ["Провести обряд", "Perform", "Ritual"], ["шёпот", "whisper"], ["Подтвердить", "Confirm"]]);
  await walkMenu(row, [["тотемы", "totems"], ["Как это работает", "How it works"]]);
  settle(6);
};

actions.quarryRush = async (row) => {
  if (Number(walletOf(row.id).coins ?? 0) < 6000) await actions.mint(row);
  // карьер запрещено запускать выше CONFIG.quarry.maxY: игрок обязан спуститься в шахту.
  // На ярусе спавна (y=71) заявка отклоняется всегда, поэтому пробуем и сверху, и снизу —
  // иначе аудит карьеров молчит «нет карьеров» и проверяет только собственный отказ
  const deep = chance(0.7);
  row.player.teleport({
    x: between(90, 200) + 0.5,
    y: deep ? 63 : 71,
    z: between(-200, -90) + 0.5,
  });
  await settle(2);
  await walkMenu(row, [["Авто-шахта", "quarry"], ["Запустить", "Launch"], ["Подтверд", "Confirm"]]);
  await runCmd("sw:quarry", row.player, "start");
  settle(between(20, 60));
  await runCmd("sw:quarry", row.player, "collect");
  await runCmd("sw:quarry", row.player, "status");
  if (chance(0.2)) await runCmd("sw:quarry", row.player, "close");
};

actions.rankRoll = async (row) => {
  // кейс рангов: ранг навсегда, поэтому дубликат обязан возвращать часть монет. Дорогой
  // путь — сначала гарантируем баланс на пять круток, иначе меню просто откажет.
  // Кнопки ищутся по «×5»/«×1»: полная подпись — «Крутить кейс рангов ×5 · 12000 ₡»
  const price = 2400;
  if (Number(walletOf(row.id).coins ?? 0) < price * 6) await actions.mint(row);
  const snapshot = () => {
    const meta = probe.economy?.metaOf?.(row.player);
    const owned = Array.isArray(meta?.rankOwned) ? meta.rankOwned.slice() : [];
    return { coins: Number(meta?.coins ?? 0), owned };
  };
  const ranksOn = probe.economy?.getTunables?.().ranksEnabled !== false;
  // «не дошло» имеет право быть только по причине отказа, а не бедности: монеты на
  // пять круток могли не зайти (лимит эмиссии на день), и тогда пустой результат нормален
  const funded = Number(probe.economy?.metaOf?.(row.player)?.coins ?? 0) >= price * 5;
  const was = snapshot();
  await walkMenu(row, [["Ранги", "Ranks"], "×5"]);
  const now = snapshot();
  if (ranksOn) {
    reached.ranksIssued = Math.max(reached.ranksIssued, now.owned.length);
    // списание сверяем только «не больше» и «не больше круток»: монеты игроку могут
    // придти и из карьера в этих же тактах, поэтому «списано меньше цены» — не нарушение
    const spent = was.coins - now.coins;
    if (spent > price * 5) report(roundNow, "кейс рангов списал больше объявленной цены", `${row.id}: ${spent} > ${price * 5}`);
    if (now.owned.length > was.owned.length + 5) {
      report(roundNow, "рангов выдано больше, чем было круток", `${row.id}: ${was.owned.length} → ${now.owned.length} за 5 круток`);
    }
    // и требование, чтобы путь вообще состоялся: иначе «кнопку не нашли, форма отменилась»
    // неотличимо от «всё в порядке, просто цена верная» — классический вакуум
    const gotRanks = now.owned.length > was.owned.length;
    if (funded && spent === 0 && !gotRanks) {
      report(roundNow, "крутка кейса рангов не дошла до состояния", `${row.id}: списано ${spent}, рангов ${was.owned.length} → ${now.owned.length}`);
    }
  }
  await walkMenu(row, [["Ранги", "Ranks"], "×1"]);
  await runCmd("sw:rank", row.player, "top");
};

actions.massJoin = async () => {
  // очередь на вход при потоке подключений: каждый обязан зайти ровно один раз
  const before = mc.state.players.length;
  const extra = [];
  for (let index = 0; index < 6; index += 1) {
    const id = `p-x${roundNow}-${index}`;
    everCreated.add(id);
    extra.push(mc.makePlayer(id, `T_${roundNow}_${index}`, { x: between(-30, 30) + 0.5, y: 81, z: between(-30, 30) + 0.5 }));
  }
  settle(between(10, 40));
  for (const player of extra) {
    mc.fire("after", "playerSpawn", { player, initialSpawn: false });
    mc.removePlayer(player);
  }
  settle(between(6, 20));
  if (mc.state.players.length !== before) {
    report(roundNow, "после волны входов/выходов счётчик игроков разошёлся", `${before} → ${mc.state.players.length}`);
  }
};

const WEIGHTS = [
  ["menu", 12], ["commands", 11], ["caseRush", 8], ["shopBuy", 7], ["questTwice", 6],
  ["acBurst", 6], ["totemForge", 5], ["quarryRush", 5], ["massJoin", 3], ["rankRoll", 5],
  ["marketSell", 5], ["breakSpawn", 8], ["placeSpawn", 7], ["digWild", 6],
  ["blast", 4], ["buckets", 4], ["fight", 6], ["die", 4], ["churn", 6], ["move", 8],
  ["interact", 4], ["pickup", 5], ["mint", 6], ["timeWarp", 7], ["restart", 2],
  ["toggles", 4], ["adminCommands", 4],
];
const ACTION_BAG = WEIGHTS.flatMap(([name, weight]) => Array.from({ length: weight }, () => name));

const press = (form, part) => {
  const index = (form.buttons ?? []).findIndex((label) => label.includes(part));
  return index < 0 ? "cancel" : index;
};
const fill = (form, values) =>
  values.map((value, index) => {
    const control = (form.controls ?? [])[index];
    if (!control) return value;
    if (control.type === "dropdown" && typeof value === "string") {
      const position = (control.options ?? []).findIndex((option) => option.includes(value));
      return position < 0 ? "cancel" : position;
    }
    return value;
  });
const nearBuild = () => false;
const insideLobby = (cell) => {
  const dx = cell.x + 0.5 - 0;
  const dz = cell.z + 0.5 - 0;
  return Math.hypot(dx, dz) <= 24;
};
// тумблеры читаем из живого модуля, а не из сохранённого JSON: flush в мок-мире
// происходит раз в раунд, и readJson отставал бы на целый раунд
const isProtectOn = () => (probe.spawn?.spawnProtectActive ? probe.spawn.spawnProtectActive() : readJson("sw:eco:cfg")?.spawnProtectEnabled !== false);
const changedByActions = new Set();
const intervalsAfterReload = [];

// ──────────────────────────────────────────────────────────────────────────────
// 5. Инварианты
// ───────────────────────────────────────────────
// 1. ──────────────────────────────────────────────────────────────────────────
const KNOWN_WALLET_FIELDS = new Set([
  "name", "updatedAt", "joinedAt", "playSeconds", "banned", "rank", "rankAt", "rankOwned", "rankTag",
  "coins", "lockedCoins", "lockedUntil", "mintDay", "mintToday", "receiveDay", "receiveToday",
  "pairDay", "pair", "lastTransferAt", "soldDay", "sold", "caseKeys", "casePulls", "pity", "hearts",
  "streak", "streakBest", "pvpKills", "pvpDeaths", "streakAt", "donorTier", "donorUntil", "dailyDay",
  "dailyStreak", "owned", "equippedPrefix", "equippedSuffix", "equippedTrail", "equippedJoin",
  "cosmeticsAt", "receipts", "bought", "clan", "clanRole", "clanAt", "homeX", "homeY", "homeZ",
  "homeDim", "homeAt", "quests", "questDay", "refCode", "refBound", "refCount", "refCoins",
  "totems", "totemSlot", "immunityUntil", "quarries", "playToday", "playDay", "lastEvent", "events",
  "hudOff", "acScore", "lastQuitAt", "lastJoinAt", "donorHearts", "progress", "claimSerial", "serial",
]);
const KNOWN_PROFILE_FIELDS = new Set([
  "name", "lang", "kills", "deaths", "playSeconds", "joinedAt", "lastSeen", "banned", "banReason",
  "banUntil", "acScore", "flags", "rtpReadyAt", "mobile", "playToday", "playDay",
]);
const isNumericInt = (value) => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
/** границы hearts синхронизированы с lifesteal: minLevel/maxLevel в src/events/config.ts */
const LIFESTEAL_MIN_HEARTS = Number(process.env.SOAK_HEARTS_MIN ?? -3);
const LIFESTEAL_MAX_HEARTS = Number(process.env.SOAK_HEARTS_MAX ?? 6);

const audits = [];
const audit = (name, fn) => audits.push({ name, fn });

/** курсор по ui.shown: тексты форм (заголовки, тела, подписи кнопок) — то же поле боя, что и чат */
let formCursor = 0;
const formTexts = (record) => [
  String(record.title ?? ""),
  String(record.body ?? ""),
  ...(record.buttons ?? []).map((label) => String(label)),
  ...(record.controls ?? []).map((control) => {
    const options = Array.isArray(control.options) ? control.options.join(" ") : "";
    return `${String(control.label ?? "")} ${String(control.placeholder ?? "")} ${options}`;
  }),
];

audit("деньги: целые, неотрицательные, без NaN", (round, wallets) => {
  let sum = 0;
  for (const [id, wallet] of Object.entries(wallets)) {
    for (const field of ["coins", "lockedCoins", "caseKeys", "pity", "hearts", "streak", "streakBest", "pvpKills", "pvpDeaths", "dailyStreak"]) {
      const value = wallet?.[field];
      if (value === undefined) continue;
      if (!isNumericInt(value)) {
        report(round, "нечисловое поле кошелька", `${id}.${field} = ${JSON.stringify(value)}`);
        continue;
      }
      // hearts — единственное поле кошелька, которое умеет быть отрицательным: lifesteal
      // держит «долг» до CONFIG.minLevel, и это часть дизайна (кап HP тогда ниже базового)
      const floor = field === "hearts" ? LIFESTEAL_MIN_HEARTS : 0;
      if (value < floor) report(round, "поле кошелька ниже дна", `${id}.${field} = ${value} (дно ${floor})`);
      if (field === "hearts" && value > LIFESTEAL_MAX_HEARTS) report(round, "hearts выше потолка", `${id}: ${value} > ${LIFESTEAL_MAX_HEARTS}`);
    }
    sum += Number(wallet?.coins ?? 0) + Number(wallet?.lockedCoins ?? 0);
  }
  return `Σ монет ${sum}`;
});

const moneySum = (wallets, ledger) => {
  let sum = 0;
  for (const wallet of Object.values(wallets)) sum += Number(wallet?.coins ?? 0) + Number(wallet?.lockedCoins ?? 0);
  for (const account of Object.values(ledger?.accounts ?? {})) sum += Number(account?.coins ?? 0);
  return sum;
};

audit("эмиссия: деньги в системе = minted - burned (ни печати, ни испарения)", (round, wallets, ledger) => {
  const circulation = Number(ledger?.minted ?? 0) - Number(ledger?.burned ?? 0);
  const sum = moneySum(wallets, ledger);
  const drift = sum - circulation;
  if (Math.abs(drift) > 2) {
    report(round, drift > 0 ? "монеты появились из ниоткуда" : "монеты исчезли", `в кошельках и счетах ${sum}, minted-burned ${circulation}, расхождение ${drift}`);
  }
  expectedMoney = sum;
  if (Number(ledger?.burned ?? 0) < 0) report(round, "отрицательный burn", JSON.stringify(ledger));
  if (Number(ledger?.minted ?? 0) < 0) report(round, "отрицательный mint", JSON.stringify(ledger));
  return `circulation ${circulation}, расхождение ${drift}`;
});
let expectedMoney = 0;

audit("кэш-лимит баланса: maxBalance не пробит и не съедает монеты", (round, wallets) => {
  const maxBalance = Number(readJson("sw:eco:cfg")?.maxBalance ?? 0) || 1_000_000_000;
  for (const [id, wallet] of Object.entries(wallets)) {
    const coins = Number(wallet?.coins ?? 0);
    if (coins > maxBalance) report(round, "баланс выше maxBalance", `${id}: ${coins} > ${maxBalance}`);
    if (coins === maxBalance && Number(wallet?.mintToday ?? 0) > 0) {
      report(round, "начисление на купол: монеты могли исчезнуть", `${id}: ${coins}`);
    }
  }
  return `maxBalance ${maxBalance}`;
});

audit("клог транзакций: журнал не расходится с ledger", (round, wallets, ledger) => {
  const tx = readJson("sw:eco:tx");
  const rows = Array.isArray(tx) ? tx : (tx?.rows ?? []);
  const count = Number(ledger?.txCount ?? 0);
  if (!Number.isFinite(count) || count < 0) report(round, "кривой txCount", String(ledger?.txCount));
  if (rows.length > 0 && count === 0) report(round, "журнал непустой, а txCount = 0", `${rows.length} против ${count}`);
  return `журнал ${rows.length}, ledger.txCount ${count}`;
});

audit("лимиты минта за сутки соблюдаются", (round, wallets, ledger) => {
  const cfg = readJson("sw:eco:cfg") ?? {};
  const dayMax = Number(cfg.mintDayMaxPerPlayer ?? cfg.dayMaxPerPlayer ?? 0);
  if (!(dayMax > 0)) return "лимита нет";
  for (const [id, wallet] of Object.entries(wallets)) {
    if (Number(wallet?.mintToday ?? 0) > dayMax) {
      report(round, "лимит минта за сутки пробит", `${id}: ${wallet.mintToday} > ${dayMax}`);
    }
  }
  return `dayMax=${dayMax}`;
});

audit("профили: валидный JSON, известные поля, ак-скор в диапазоне", (round) => {
  let checked = 0;
  for (const row of liveRows()) {
    const raw = row.player.getDynamicProperty(`sw:p:${row.id}`);
    if (typeof raw !== "string") continue;
    let profile;
    try {
      profile = JSON.parse(raw);
    } catch (error) {
      report(round, "профиль не парсится", `${row.id}: ${String(error?.message ?? error)} / ${raw.slice(0, 60)}`);
      continue;
    }
    checked += 1;
    for (const key of Object.keys(profile)) {
      if (!KNOWN_PROFILE_FIELDS.has(key)) report(round, "неизвестное поле профиля", `${row.id}.${key}`);
    }
    const score = Number(profile.acScore ?? 0);
    if (!Number.isFinite(score) || score < 0 || score > 100) report(round, "acScore вне 0..100", `${row.id}: ${profile.acScore}`);
    if (Number(profile.playToday ?? 0) > Number(profile.playSeconds ?? 0) + 1) {
      report(round, "«за сегодня» больше «за всё время»", `${row.id}: ${profile.playToday} > ${profile.playSeconds}`);
    }
    if (!Number.isInteger(Number(profile.playSeconds ?? 0)) || Number(profile.playSeconds ?? 0) < 0) {
      report(round, "кривое playSeconds", `${row.id}: ${profile.playSeconds}`);
    }
    if (typeof profile.lang !== "string" || !["ru", "en"].includes(profile.lang)) report(round, "неизвестный язык профиля", `${row.id}: ${profile.lang}`);
  }
  return `${checked} профилей`;
});

audit("ранги: лучший = max(owned), owned уникальны и известны, префикс совпадает", (round) => {
  const ladder = probe.metaConfig?.RANKS ?? [];
  const byIdMap = new Map(ladder.map((rank) => [rank.id, rank]));
  if (byIdMap.size === 0) report(round, "аудит рангов стал бы вакуумным", "нет probe.metaConfig.RANKS");
  for (const row of liveRows()) {
    const view = probe.ranks?.rankProbe?.(row.player);
    if (!view) continue;
    const wallet = readJson("sw:eco:meta")?.[row.id] ?? {};
    const owned = Array.isArray(wallet.rankOwned) ? wallet.rankOwned : [];
    if (owned.length !== new Set(owned).size) report(round, "дубли рангов в owned", `${row.id}: ${owned.join(",")}`);
    if (view.owned !== owned.length) report(round, "rankProbe и кошелёк разошлись", `${row.id}: ${view.owned} vs ${owned.length}`);
    for (const id of owned) {
      if (byIdMap.size > 0 && !byIdMap.has(id)) report(round, "неизвестный id ранга в owned", `${row.id}: ${id}`);
    }
    const bestOrder = owned.reduce((best, id) => Math.max(best, Number(byIdMap.get(id)?.order ?? 0)), 0);
    const ownOrder = Number(byIdMap.get(view.best)?.order ?? 0);
    if (byIdMap.size > 0 && ownOrder !== bestOrder) {
      report(round, "лучший ранг не=max(owned)", `${row.id}: best=${view.best}(${ownOrder}) из ${owned.join(",")}(max ${bestOrder})`);
    }
    const tag = String(wallet.rankTag ?? "");
    // тумблер читаем из живого модуля (сохранённый JSON отстаёт на раунд), а синхронизацию
    // вызываем сами — это ровно то, что делает задача meta-ranks; иначе проверка меряла бы
    // такт задачи (600 тиков), а не поведение
    const ranksOn = probe.economy?.getTunables?.().ranksEnabled !== false;
    if (ranksOn && owned.length > 0) probe.ranks?.syncRankTags?.();
    const synced = String(probe.ranks?.rankProbe?.(row.player)?.tag ?? tag);
    if (ranksOn && owned.length > 0 && synced.length === 0) {
      report(round, "есть ранги, но префикса нет даже после syncRankTags", `${row.id}: ${owned.join(",")}`);
    }
    if (String(row.player.nameTag ?? "").includes("undefined") || String(row.player.nameTag ?? "").includes("NaN")) {
      report(round, "мусор в nameTag", `${row.id}: ${row.player.nameTag}`);
    }
  }
  reached.ranksIssued = Math.max(reached.ranksIssued, liveRows().filter((row) => (probe.ranks?.rankProbe?.(row.player)?.owned ?? 0) > 0).length);
  return `${liveRows().length} игроков`;
});

audit("спавн: blueprint не разрастается, площадь сходится целиком, мусора нет", (round) => {
  const size = probe.spawnBuild?.spawnBlueprintSize?.();
  if (typeof size !== "number") return "нет probe";
  if (expectedBlueprintSize !== undefined && size !== expectedBlueprintSize) {
    report(round, "размер blueprint'а изменился в рантайме", `${expectedBlueprintSize} → ${size} (дубли клеток = вечная «починка»)`);
  } else {
    expectedBlueprintSize = size;
  }
  // Проверка целостности смотрит выборку (24 клетки из 968 + критические), поэтому
  // «все дыры закрыты сразу» было бы ложным требованием. Требование другое: ПОЛНАЯ починка
  // (её делает sw:spawn repair) обязана свести площадь к плану — и дыры, и чужие блоки.
  // Прямые вызовы spawnBuildTick, не трогая мировые тики: они сдвигали бы тайминги hud/ranks.
  const statusBefore = probe.spawnBuild?.spawnStatus?.() ?? {};
  if (statusBefore.running) {
    for (let index = 0; index < 600 && probe.spawnBuild.spawnStatus().running; index += 1) probe.spawnBuild.spawnBuildTick();
  }
  probe.spawnBuild?.startSpawnBuild?.("soak", "repair", { sweep: true });
  for (let index = 0; index < 600 && probe.spawnBuild.spawnStatus().running; index += 1) probe.spawnBuild.spawnBuildTick();
  if (probe.spawnBuild?.spawnStatus?.().running) report(round, "полная починка не завершилась за 600 проходов", JSON.stringify(probe.spawnBuild.spawnStatus()));

  const blueprint = probe.spawnBuild?.spawnBlueprint?.() ?? [];
  const ground = mc.state.groundY;
  const worldAt = (cell) => {
    const key = `${cell.x}:${cell.y}:${cell.z}`;
    const override = mc.state.blockOverrides.get(key);
    if (override !== undefined) return override;
    return cell.y > ground ? "minecraft:air" : cell.y === ground ? "minecraft:grass" : "minecraft:stone";
  };
  const mismatched = [];
  for (const cell of blueprint) {
    if (worldAt(cell) !== cell.typeId) mismatched.push(`${cell.x},${cell.y},${cell.z}: ${worldAt(cell)} ≠ ${cell.typeId}`);
  }
  if (mismatched.length > 0) {
    report(round, "площадь спавна не совпала с blueprint после починки", `${mismatched.length} клеток: ${mismatched.slice(0, 4).join(" | ")}`);
  }
  // обратная сторона: вне blueprint на площади не должно остаться игроцких блоков
  const cells = new Set(blueprint.map((cell) => `${cell.x}:${cell.y}:${cell.z}`));
  const junk = [];
  for (const [key, value] of mc.state.blockOverrides) {
    const [x, , z] = key.split(":").map(Number);
    if (!insideLobby({ x, z })) continue;
    if (cells.has(key)) continue;
    if (value !== "minecraft:air") junk.push(`${key}=${value}`);
  }
  if (junk.length > 0) report(round, "на защищённой площади остались чужие блоки", `${junk.length}: ${junk.slice(0, 4).join(" ")}`);
  if (isProtectOn()) {
    const status = probe.spawn?.spawnProtectStatus?.() ?? {};
    if (status.enabled === false) report(round, "защита выключена, хотя тумблер включён", JSON.stringify(status).slice(0, 120));
  }
  return `${size} клеток, расхождений ${mismatched.length}, мусора ${junk.length}`;
});

audit("hud: длина строк, призраки ушедших, сайдбар", (round) => {
  const hud = probe.hud?.hudProbe?.();
  if (!hud) return "нет probe";
  const alive = aliveIds();
  const ghosts = (hud.lastText ?? []).filter(([id]) => !alive.has(id) && id !== "admin");
  if (ghosts.length > 0) report(round, "hud помнит ушедших игроков", ghosts.map(([id]) => id).join(", "));
  if ((hud.manualOff ?? []).length > roster.length) report(round, "список «off» растёт без предела", `${hud.manualOff.length}`);
  const rows = mc.scoreboardLines("Sidebar");
  if (rows.length > 10) report(round, "в сайдбаре больше 10 строк", `${rows.length}`);
  for (const line of rows) {
    if (/undefined|NaN|\[object Object\]/.test(line)) report(round, "мусор в строке сайдбара", line);
    if (line.length > 40) report(round, "длинная строка сайдбара", `${line.length}: ${line}`);
  }
  const bars = mc.state.actionBars.slice(-240);
  for (const bar of bars) {
    const text = String(bar.value ?? "").replace(/§./g, "");
    if (!alive.has(roster.find((row) => row.player.name === bar.to)?.id ?? "")) continue;
    if (text.length > 191) report(round, "action bar длиннее 191 символа", `${bar.to}: ${text.length}`);
  }
  return `бар-записей ${hud.barWrites}, сайдбар ${rows.length} строк`;
});
let expectedBlueprintSize;

audit("текст форм: подписи кнопок и тела без {плейсхолдеров} и сырых ключей", (round) => {
  const fresh = ui.shown.slice(formCursor);
  formCursor = ui.shown.length;
  if (ui.shown.length > 4000) ui.shown.splice(0, ui.shown.length - 2000);
  let checked = 0;
  for (const record of fresh) {
    for (const text of formTexts(record)) {
      const plain = text.replace(/§./g, "");
      if (plain.length === 0) continue;
      checked += 1;
      const left = plain.match(/\{(\w+)\}/);
      if (left) report(round, "в форме неподставленный плейсхолдер", `${record.title} → {${left[1]}}`);
      if (/undefined|NaN|\[object Object\]/.test(plain)) report(round, "мусор в тексте формы", `${record.title}: ${plain.slice(0, 90)}`);
      const key = plain.match(/(?:^|[\s(])([a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*)(?=$|[\s).,:])/);
      if (key) report(round, "в форме сырой ключ", `${record.title}: ${key[1]}`);
    }
  }
  return `${fresh.length} форм, ${checked} подписей`;
});

audit("текст: ни сырых ключей, ни undefined, ни непоставленных плейсхолдеров", (round) => {
  const fresh = [
    ...mc.state.chat.slice(chatCursor),
    ...mc.state.titles.slice(titleCursor),
    ...mc.state.actionBars.slice(barCursor),
    ...mc.state.sentMessages.slice(sentCursor),
  ];
  chatCursor = mc.state.chat.length;
  titleCursor = mc.state.titles.length;
  barCursor = mc.state.actionBars.length;
  sentCursor = mc.state.sentMessages.length;
  let checked = 0;
  for (const row of fresh) {
    const text = typeof row === "string" ? row : String(row?.value ?? row?.text ?? "");
    if (text.length === 0) continue;
    checked += 1;
    const plain = text.replace(/§./g, "");
    if (/undefined|NaN|\[object Object\]|null is|℉".*null/.test(plain)) report(round, "мусор в тексте игрока", plain.slice(0, 120));
    if (/\{[a-zA-Z_][a-zA-Z_0-9]*\}/.test(plain)) report(round, "неподставленный плейсхолдер", plain.slice(0, 120));
    if (/(^|[\s(])([a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*)(?=$|[\s).,:])/ .test(plain)) {
      const key = plain.match(/([a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*)/)[1];
      if (!/[.](?:js|ts|json|minecraft)$/.test(key) && !/^\d|^v\d/.test(key)) report(round, "в текст уехал сырой ключ", `${key} ← ${plain.slice(0, 100)}`);
    }
    // 900 — тот же предел, что у clip() в реестре команд: клиент обрезает длинную строку,
    // и хвост отчёта теряется молча. Аудит идёт по курсору, поэтому видит ВСЕ новые строки
    if (plain.length > 900) {
      report(round, "сообщение длиннее 900 символов", `${row?.to ?? "всем"}: ${plain.length}: ${plain.slice(0, 60)}`);
    }
  }
  return `${checked} свежих строк`;
});
let chatCursor = 0;
let titleCursor = 0;
let barCursor = 0;
let sentCursor = 0;

audit("хранилище: ключи, размер, битый JSON", (round) => {
  const ids = mc.world.getDynamicPropertyIds();
  const total = mc.world.getDynamicPropertyTotalByteCount();
  if (total > 4_000_000) report(round, "превышен бюджет динамических свойств", `${total} байт`);
  let broken = 0;
  for (const key of ids) {
    if (key.length > 32_767) report(round, "слишком длинный ключ DP", key.slice(0, 60));
    if (/^(sw:[a-z:]+):\d+$/.test(key)) {
      const count = mc.world.getDynamicProperty(`${key.replace(/:\d+$/, "")}:n`);
      if (typeof count === "number" && count <= 0) broken += 1;
    }
    const value = mc.world.getDynamicProperty(key);
    if (typeof value === "string" && (value === "undefined" || value === "null")) report(round, "в DP записана строка-мусор", key);
  }
  if (broken > 0) report(round, "chunk'и без счётчика", `${broken} ключей`);
  for (const row of liveRows()) {
    for (const key of [...(row.player._props?.keys() ?? [])]) {
      const value = row.player.getDynamicProperty(key);
      if (typeof value === "string" && value.length > 30_000) report(round, "профиль игрока близко к лимиту DP", `${row.id}.${key}: ${value.length}`);
    }
  }
  return `${ids.length} ключей, ${total} байт`;
});

audit("таймеры и память: ни дублей, ни growth", (round) => {
  const intervals = mc.state.intervals.length;
  if (baselineIntervals === undefined) baselineIntervals = intervals;
  if (intervals !== baselineIntervals) {
    report(round, "после reload число интервалов изменилось", `${baselineIntervals} → ${intervals} (двойная регистрация задач)`);
  }
  if (mc.state.timeouts.length > 200) report(round, "таймауты копятся", `${mc.state.timeouts.length}`);
  if (mc.state.runQueue.length > 0) report(round, "runQueue не опустел", `${mc.state.runQueue.length} задач застряло`);
  // мок копит все spawnParticle/sendMessage навсегда — абсолютное число ничего не говорит.
  // Показателен темп: трейлы доноров рисуются на игрока за тик; всплеск выше разумного
  // значит, что частицы/сообщения летят вхолостую (например, каждой строкой сайдбара).
  const players = Math.max(1, mc.state.players.length);
  const dt = Math.max(1, mc.state.tick - lastSample.tick);
  const dParticles = mc.state.particles.length - lastSample.particles;
  const dChat = mc.state.chat.length - lastSample.chat;
  lastSample = { tick: mc.state.tick, particles: mc.state.particles.length, chat: mc.state.chat.length };
  if (dParticles > players * 6 * dt) report(round, "частицы летят чаще, чем на игрока в тик", `${dParticles} за ${dt} тиков на ${players} игроков`);
  if (dChat > players * 4 * dt) report(round, "чат летит чаще, чем на игрока в тик", `${dChat} за ${dt} тиков на ${players} игроков`);
  return `интервалов ${intervals}, таймаутов ${mc.state.timeouts.length}`;
});
let baselineIntervals;
let lastSample = { tick: 0, particles: 0, chat: 0 };

audit("античит: скоринг в диапазоне, память детекторов освобождается", (round) => {
  const scores = probe.anticheat?.acScores?.();
  if (!scores) return "нет probe";
  // acScores перечисляет только онлайн, поэтому «призраков» он не увидит никогда. Память
  // детекторов смотрим напрямую: states растёт на каждом входе и обязан очищаться на выходе
  const entries = Array.isArray(scores) ? scores : [];
  for (const row of entries) {
    const score = Number(row?.score);
    if (Number.isFinite(score) && (score < 0 || score > 100)) report(round, "ac-скор вне 0..100", `${row?.name}: ${score}`);
  }
  const tracked = Number(probe.anticheat?.acTrackedCount?.() ?? 0);
  const alive = mc.state.players.length;
  // запас на оффлайн-грейс и на то, что состояние создаётся чтением playerScore
  const slack = Math.max(8, Math.ceil(ROUNDS / 10));
  if (tracked > alive + slack) report(round, "античит копит состояние ушедших игроков", `${tracked} состояний при ${alive} онлайн`);
  return `${entries.length} с nonzero, ${tracked} состояний при ${alive} онлайн`;
});

audit("кейсы и косметика: счётчики не противоречат друг другу", (round) => {
  const wallets = readJson("sw:eco:meta") ?? {};
  const log = readJson("sw:cases:log");
  const rows = Array.isArray(log?.rows ?? log) ? (log.rows ?? log) : [];
  if (rows.length > 300) report(round, "журнал выдач кейсов не ограничен", `${rows.length} записей`);
  // и глобальный счётчик, и кошельки берём из памяти, одним и тем же срезом времени:
  // сохранённый JSON отстаёт на такт автосейва, и сравнение по нему ловило бы задержку
  // записи, а не расхождение счётчиков (это и дало ложные «stats 43 против Σ 25»)
  let pulls = 0;
  for (const id of everCreated) pulls += Number(probe.economy?.peekWallet?.(id)?.casePulls ?? 0);
  const livePulls = liveRows().reduce((sum, live) => sum + Number(probe.economy?.metaOf?.(live.player)?.casePulls ?? 0), 0);
  const globalPulls = Number(probe.cases?.caseStats?.().pulls ?? 0);
  if (globalPulls !== pulls) report(round, "статистика кейсов не сходится с кошельками", `стат ${globalPulls} против Σ pull ${pulls}`);
  if (livePulls > pulls) report(round, "кошелёк онлайн-игрока показывает больше круток, чем память", `${livePulls} > ${pulls}`);
  for (const [id, wallet] of Object.entries(wallets)) {
    if (Number(wallet?.pity ?? 0) < 0) report(round, "отрицательный pity", `${id}: ${wallet.pity}`);
    const owned = Array.isArray(wallet?.owned) ? wallet.owned : [];
    if (owned.length !== new Set(owned).size) report(round, "дубликаты в owned косметики", `${id}: ${owned.join(",")}`);
    if (Number(wallet?.caseKeys ?? 0) > 5000) report(round, "подозрительно много ключей", `${id}: ${wallet.caseKeys}`);
  }
  reached.cases = Math.max(reached.cases, pulls);
  return `всего круток ${pulls}, журнал ${rows.length}`;
});

audit("античит наказал читера, но не устроил волну киков", (round) => {
  const scores = probe.anticheat?.acRuntimeSummary?.() ?? "";
  const kicks = mc.state.kicked.length;
  if (kicks > roster.length * 4 + 8) report(round, "волна киков", `${kicks} за прогон при ${roster.length} игроках`);
  const scoreRows = probe.anticheat?.acScores?.();
  if (Array.isArray(scoreRows)) {
    for (const row of scoreRows) {
      const score = Number(row?.score ?? row?.value);
      if (Number.isFinite(score) && score > 100) report(round, "скоринг выше 100", JSON.stringify(row).slice(0, 120));
    }
  }
  if (Array.isArray(scoreRows)) reached.acScore = Math.max(reached.acScore, scoreRows.length);
  return `киков ${kicks}, сводка: ${String(scores).slice(0, 60)}`;
});

audit("тотемы после ковки: заряды, серийники и иммунитет в границах", (round) => {
  const store = readJson("sw:totems");
  if (!store) return "нет хранилища тотемов";
  const rows = store.rows ?? [];
  if (rows.length === 0) return "0 записей";
  const serials = new Set();
  for (const row of rows) {
    if (row.serial !== undefined) {
      if (serials.has(row.serial)) report(round, "дубликат serial тотема", String(row.serial));
      serials.add(row.serial);
    }
    const charges = Number(row?.charges ?? 0);
    if (!Number.isInteger(charges) || charges < 0) report(round, "кривой заряд тотема", JSON.stringify(row).slice(0, 140));
    if (charges > 20) report(round, "заряд тотема выше разумного потолка", `${row?.serial}: ${charges}`);
  }
  if (rows.length > (roster.length + 4) * 8) report(round, "реестр тотемов раздут", `${rows.length}`);
  const immunity = probe.totems?.immunityLeft?.(liveRows()[0]?.player) ?? 0;
  if (!(immunity >= 0 && immunity <= 600_000)) report(round, "иммунитет после спасения вне границ", String(immunity));
  reached.totemRows = Math.max(reached.totemRows, rows.length);
  return `${rows.length} записей, иммунитет ${immunity}`;
});

audit("карьеры: буфер и добыча ограничены, collect не печатает монеты", (round) => {
  const store = readJson("sw:quarry");
  const claims = store?.claims ?? [];
  if (claims.length === 0) return "нет карьеров";
  let cells = 0;
  for (const claim of claims) {
    cells += Number(claim?.mined ?? 0);
    const buffer = Array.isArray(claim?.buffer) ? claim.buffer : [];
    if (buffer.length > 400) report(round, "буфер карьера раздут", `${claim?.id}: ${buffer.length} стопок`);
    for (const stack of buffer) {
      if (!(Number(stack?.amount ?? 0) > 0) || Number(stack?.amount ?? 0) > 999) report(round, "кривая стопка в буфере", JSON.stringify(stack).slice(0, 120));
    }
    if (Number(claim?.mined ?? 0) < 0) report(round, "отрицательная добыча", JSON.stringify(claim).slice(0, 120));
  }
  reached.quarryClaims = Math.max(reached.quarryClaims, claims.length);
  return `${claims.length} карьеров, суммарно добыто ${cells}`;
});

audit("кланы: индекс ↔ документы симметричны, имя свободно, банк неотрицателен", (round, wallets, ledger) => {
  const index = readJson("sw:clans:index");
  if (!index) return "индекса кланов нет";
  const clanIds = Array.isArray(index.clanIds) ? index.clanIds : [];
  const byPlayer = index.byPlayer ?? {};
  const names = index.names ?? {};
  const known = new Set(clanIds);
  for (const id of clanIds) {
    const doc = readJson(`sw:clan:${id}`);
    if (!doc || doc.__broken) {
      report(round, "в индексе клан без документа", `${id}: ${JSON.stringify(doc).slice(0, 60)}`);
      continue;
    }
    const members = Array.isArray(doc.members) ? doc.members : [];
    for (const member of members) {
      if (byPlayer[member.id] !== id) report(round, "участник есть в клане, но не в byPlayer", `${member.name}: byPlayer=${byPlayer[member.id]} клан=${id}`);
    }
    for (const [playerId, clanId] of Object.entries(byPlayer)) {
      if (clanId !== id) continue;
      if (!members.some((member) => member.id === playerId)) report(round, "byPlayer ссылается на не-участника", `${playerId} → ${id}`);
    }
    if (members.length > 0 && !members.some((member) => member.role === "leader")) {
      report(round, "в клане нет лидера", `${doc.name}: ${members.map((member) => `${member.name}:${member.role}`).join(", ")}`);
    }
    if (Number(doc.bank ?? 0) < 0) report(round, "отрицательная казна клана", `${doc.name}: ${doc.bank}`);
    if (Number(index.totalBytes ?? 0) > 8000) report(round, "индекс кланов раздут", `${index.totalBytes} байт`);
  }
  for (const [clanId] of Object.entries(names)) {
    if (known.size > 0 && !names[clanId]) report(round, "в names пустая запись", String(clanId));
  }
  for (const playerId of Object.keys(byPlayer)) {
    if (!known.has(byPlayer[playerId])) report(round, "byPlayer ведёт в несуществующий клан", `${playerId} → ${byPlayer[playerId]}`);
  }
  return `${clanIds.length} кланов, ${Object.keys(byPlayer).length} привязок`;
});

audit("карьеры: границы площади и буфера", (round) => {
  const store = readJson("sw:quarry");
  if (!store) return "нет карьеров";
  const claims = Array.isArray(store.claims ?? store) ? (store.claims ?? store) : [];
  for (const claim of claims) {
    const cells = Number(claim?.cells ?? 0);
    if (!Number.isFinite(cells) || cells < 0) report(round, "кривое число клеток карьера", JSON.stringify(claim).slice(0, 120));
    const x = Number(claim?.x ?? 0);
    const z = Number(claim?.z ?? 0);
    if (isProtectOn() && insideLobby({ x, z })) report(round, "карьер поставлен в зоне спавна", `${x},${z}`);
  }
  if (claims.length > roster.length + 2) report(round, "карьеров больше, чем игроков", `${claims.length}`);
  const summary = probe.quarry?.quarrySummary?.();
  return `${claims.length} карьеров, сводка ${String(summary).slice(0, 40)}`;
});

audit("тотемы: серийники уникальны, rowCount ≤ cap, иммунитет ограничен", (round) => {
  const store = readJson("sw:totems");
  if (!store) return "нет тотемов";
  const rows = store.rows ?? (Array.isArray(store) ? store : []);
  const serials = new Set();
  for (const row of rows) {
    const serial = row?.serial;
    if (serial !== undefined) {
      if (serials.has(serial)) report(round, "дубликат serial тотема", String(serial));
      serials.add(serial);
    }
  }
  if (rows.length > (roster.length + 2) * 6) report(round, "тотемов подозрительно много", `${rows.length}`);
  return `${rows.length} записей`;
});

audit("лог: ни одной ошибки и ни одного неожиданного warn", (round) => {
  const unexpected = warns.filter((line) => /ошибка|не удалось|исключени|Error|TypeError|Cannot read|undefined is not|is not a function/.test(line));
  for (const line of unexpected.slice(0, 3)) report(round, "warn про настоящую ошибку", line.slice(0, 160));
  return `log.error ${errors.length}, warn ${warns.length} (из них тревожных ${unexpected.length})`;
});

audit("память после churn: ушедшие не держат клан/hud/профиль-кэш", (round) => {
  const index = readJson("sw:clans:index");
  const byPlayer = index?.byPlayer ?? {};
  const alive = aliveIds();
  // членство в клане обязано переживать выход (иначе клан разваливался бы на каждом логине),
  // поэтому требуем не «только живые», а «только существующие» + разумный размер
  for (const playerId of Object.keys(byPlayer)) {
    if (!everCreated.has(playerId)) report(round, "клан держит игрока, которого не было в ростере", playerId);
  }
  if (Object.keys(byPlayer).length > everCreated.size + 2) report(round, "byPlayer раздут", `${Object.keys(byPlayer).length} против ${everCreated.size} id`);
  // кошелёк оффлайн-игрока обязан жить (иначе ранги и баланс теряются при выходе),
  // поэтому проверяем не «нет ли лишних», а «нет ли тех, кого никогда не было»
  const wallets = readJson("sw:eco:meta") ?? {};
  const known = everCreated;
  for (const id of Object.keys(wallets)) {
    if (!known.has(id)) report(round, "в кошельках id, которого нет в ростере", id);
  }
  if (Object.keys(wallets).length > everCreated.size + 2) report(round, "кошельков больше, чем игроков", `${Object.keys(wallets).length} против ${everCreated.size} id`);
  const cache = probe.hud?.hudProbe?.() ?? {};
  for (const playerId of Object.keys(byPlayer)) {
    if (alive.has(playerId)) continue;
    if ((cache.lastText ?? []).some(([id]) => id === playerId)) report(round, "hud держит строку ушедшего", playerId);
  }
  return `привязок ${Object.keys(byPlayer).length}, кошельков ${Object.keys(wallets).length}`;
});

const aliveIds = () => new Set([...mc.state.players.map((player) => player.id), ...roster.filter((row) => !row.left).map((row) => row.id)]);
const liveRows = () => roster.filter((row) => !row.left && mc.state.players.includes(row.player));
const snapshotState = () => ({
  wallets: readJson("sw:eco:meta") ?? {},
  blueprint: probe.spawnBuild?.spawnBlueprintSize?.(),
  intervals: mc.state.intervals.length,
  ledger: readJson("sw:eco:ledger") ?? {},
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. Цикл
// ──────────────────────────────────────────────────────────────────────────────
const probe = globalThis.__swipecraftProbe ?? {};
spawnRoster(PLAYER_COUNT);
settle(20);
let roundNow = 0;
const stats = new Map();
/** сколько раз за прогон путь вообще доходил до состояния — иначе аудиты вакуумные */
const reached = { acScore: 0, quarryClaims: 0, totemRows: 0, marketListings: 0, cases: 0, ranksIssued: 0 };
/** чем закончился каждый аудит — ищем «vacuous» (аудит ничего не увидел и промолчал) */
const auditNotes = new Map();
const startedAt = process.hrtime.bigint();

for (let round = 1; round <= ROUNDS; round += 1) {
  roundNow = round;
  formsInRound = 0;
  for (const row of roster) row.forms = 0;
  const before = snapshotState();
  const walletsBefore = before.wallets;
  const actors = Math.max(2, Math.round(liveRows().length * (0.4 + rng() * 0.5)));
  const chosen = [...roster].sort(() => rng() - 0.5).slice(0, actors);
  for (const row of chosen) {
    if (row.left) continue;
    const name = pick(ACTION_BAG);
    stats.set(name, (stats.get(name) ?? 0) + 1);
    try {
      await actions[name]?.(row);
      await drain();
    } catch (error) {
      report(round, "действие упало", `${name} ${row.name}: ${String(error?.stack ?? error).slice(0, 200)}`);
    }
    if (chance(0.5)) settle(between(1, 5));
  }
  settle(between(6, 24));
  flushAll();
  settle(6);
  const walletsAfter = snapshotState().wallets;
  for (const key of Object.keys(walletsAfter)) {
    if (JSON.stringify(walletsBefore[key]) !== JSON.stringify(walletsAfter[key])) changedByActions.add(key);
  }
  const wallets = walletsAfter;
  const ledger = readJson("sw:eco:ledger") ?? {};
  for (const { name, fn } of audits) {
    try {
      const detail = fn(round, wallets, ledger);
      auditNotes.set(name, String(detail ?? ""));
      if (VERBOSE) log(`  r${round} ${name}: ${detail ?? ""}`);
    } catch (error) {
      report(round, "аудит упал", `${name}: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Отчёт
// ──────────────────────────────────────────────────────────────────────────────
const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
log(`\nsoak: сид ${SEED}, игроков ${roster.length}, раундов ${ROUNDS}, форм сыграно ${ui.shown.length}, ${Math.round(elapsed)} мс`);
log("действия: " + [...stats.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", "));
log(`инвариантов: ${audits.length}, log.error ${errors.length}, warn ${warns.length}`);
if (errors.length > 0) {
  log("\nОШИБКИ ЛОГА:");
  for (const line of [...new Set(errors)].slice(0, 25)) log(`  · ${line}`);
}
const byKind = new Map();
for (const finding of findings) byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
if (findings.length > 0) {
  log(`\nНАРУШЕНИЙ: ${findings.length} (уникальных видов: ${byKind.size})`);
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    log(`\n✗ ${kind} — ×${count}`);
    for (const finding of findings.filter((row) => row.kind === kind).slice(0, 4)) {
      log(`    r${finding.round}: ${finding.detail.slice(0, 240)}`);
    }
  }
} else {
  log("\nнарушений инвариантов не найдено");
}
const warnKinds = new Map();
for (const line of warns) {
  const key = line.replace(/^\[[^\]]+\]/, "").slice(0, 70);
  warnKinds.set(key, (warnKinds.get(key) ?? 0) + 1);
}
const neverReached = Object.entries(reached).filter(([, count]) => count === 0).map(([name]) => name);
if (neverReached.length > 0) {
  log(`\nпути, до состояния которых soak не дошёл (аудиты по ним молчат): ${neverReached.join(", ")}`);
}
const empty = [...auditNotes.entries()].filter(([, detail]) => /^нет |^0$|не найдено|\b0 записей$/.test(detail));
if (empty.length > 0) {
  log(`\nаудиты без данных (проверить, что они не вакуумные):`);
  for (const [name, detail] of empty) log(`  · ${name} → ${detail}`);
}
log(`\nwarn по видам: ${[...warnKinds.entries()].map(([key, count]) => `${count}× ${key}`).join(" | ").slice(0, 600)}`);
process.exitCode = findings.length > 0 || errors.length > 0 ? 1 : 0;
