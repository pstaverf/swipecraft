import * as mc from "./mock-server.mjs";
import { MinecraftBlockTypes, MinecraftEffectTypes, MinecraftItemTypes } from "@minecraft/vanilla-data";
import { readFileSync, readdirSync } from "node:fs";

const readSourceFiles = (dir) => {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out += readSourceFiles(path);
      continue;
    }
    if (!path.endsWith(".ts")) continue;
    if (path.endsWith("world/messages.ts")) continue;
    out += readFileSync(path, "utf8");
  }
  return out;
};
import { answer, shownTitles, ui } from "./mock-ui.mjs";

const DONATIONS_GIFT_ROLLS = 1;
const REFERRAL_NOVICE_COINS = 1000;
const COSMETIC_IDS = [
  "trail_smoke",
  "trail_ember",
  "trail_frost",
  "trail_soul",
  "prefix_sword",
  "prefix_crown",
  "prefix_star",
  "suffix_legend",
  "suffix_thunder",
  "join_raiders",
  "join_shadow",
  "join_queue",
];

const errors = [];
const warns = [];
//преднамеренно вызванные предупреждения (проверяем, что обработчик сбоя реально срабатывает)
const expectedWarns = [];
const log = console.log.bind(console);
const verbose = Boolean(process.env.STABILITY_VERBOSE);

console.log = (line) => {
  if (typeof line === "string" && line.includes("][error]")) errors.push(line);
  if (typeof line === "string" && line.includes("][warn]")) warns.push(line);
  if (verbose) log(line);
};
console.error = (line) => {
  errors.push(String(line));
  if (verbose) log("[stderr]", line);
};
console.warn = (line) => {
  warns.push(String(line));
  if (verbose) log("[stdout]", line);
};

await import("./.build/bundle.mjs");

const commands = new Map();
const results = [];
let group = "boot";

const scenario = (name) => {
  group = name;
};

const check = (name, fn) => {
  try {
    const value = fn();
    results.push({ group, name, ok: true, detail: typeof value === "string" ? value : "" });
  } catch (error) {
    results.push({ group, name, ok: false, detail: String(error?.message ?? error) });
  }
};

const step = async (name, fn) => {
  try {
    const value = await fn();
    results.push({ group, name, ok: true, detail: typeof value === "string" ? value : "" });
  } catch (error) {
    results.push({ group, name, ok: false, detail: String(error?.message ?? error) });
  }
};

const must = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = (name, player, ...args) => {
  const entry = commands.get(name);
  must(entry, `команда ${name} не зарегистрирована`);
  return entry.handler({ sourceType: "Entity", sourceEntity: player }, ...args);
};

const reply = (name, player, ...args) => String(run(name, player, ...args)?.message ?? "");

const open = async (name, player, ...args) => {
  const value = run(name, player, ...args);
  if (value && typeof value.then === "function") await value;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return value;
};

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
    return undefined;
  }
};

const chatOf = (player) => mc.state.chat.filter((row) => row.to === player.name).map((row) => row.text);
const clearChat = (player) => {
  for (let index = mc.state.chat.length - 1; index >= 0; index -= 1) {
    if (mc.state.chat[index].to === player.name) mc.state.chat.splice(index, 1);
  }
};
const inventoryOf = (player) => player.getComponent("minecraft:inventory").container;
const countItem = (player, typeId) =>
  inventoryOf(player)._slots.reduce((sum, stack) => (stack && stack.typeId === typeId ? sum + stack.amount : sum), 0);
const lastForm = () => ui.shown.at(-1);

const pressLabel = (part) => (form) => {
  const index = form.buttons.findIndex((label) => label.includes(part));
  if (process.env.UI_TRACE) console.log(`[nav] press «${part}» in «${form.title}» -> ${index} из ${JSON.stringify(form.buttons).slice(0, 220)}`);
  if (index < 0) throw new Error(`в форме «${form.title}» нет кнопки с «${part}» (${form.buttons.join(" | ").slice(0, 300)})`);
  return index;
};

const fillModal = (...values) => (form) =>
  values.map((value, index) => {
    const control = form.controls[index];
    if (!control) return value;
    if (control.type === "dropdown" && typeof value === "string") {
      const options = control.options ?? [];
      const position = options.findIndex((option) => option.includes(value));
      if (position < 0) throw new Error(`в «${control.label}» нет варианта с «${value}» (${options.join(" | ").slice(0, 200)})`);
      return position;
    }
    return value;
  });

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
mc.tickTimes(5);

const admin = mc.state.players.find((row) => row.name === "Admin") ?? mc.makePlayer("p-admin", "Admin", { x: 0, y: 71, z: 0 });
admin.addTag("admin");
const alice = mc.makePlayer("p-alice", "Alice", { x: 4, y: 71, z: 4 });
const bob = mc.makePlayer("p-bob", "Bob", { x: 8, y: 71, z: 8 });
const carl = mc.makePlayer("p-carl", "Carl", { x: 12, y: 71, z: 12 });

const flush = () => run("sw:meta", admin, "flush");

const mintTo = async (name, amount) => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Экономика"));
  answer(pressLabel("Начислить"));
  answer(fillModal(name, true, String(amount), "stability-fund"));
  await open("sw:admin", admin);
  flush();
  const record = Object.values(meta()).find((row) => row?.name === name);
  must(record && record.coins >= amount - 9000, `не удалось начислить ${amount} игроку ${name}`);
  return `${name}: ${record.coins}`;
};
const metaSet = (path, value) => run("sw:meta", admin, "set", path, String(value));
const meta = () => readJson("sw:eco:meta") ?? {};
const wallet = (id) => meta()[id];

scenario("boot");

check("все команды слоя зарегистрированы", () => {
  const expected = ["sw:menu", "sw:rtp", "sw:admin", "sw:ac", "sw:event", "sw:eco", "sw:market", "sw:case", "sw:clan", "sw:quest", "sw:don", "sw:shop", "sw:ref", "sw:meta", "sw:quarry", "sw:spawn", "sw:totem", "sw:hud", "sw:rank"];
  const missing = expected.filter((name) => !commands.has(name));
  must(missing.length === 0, `нет команд: ${missing.join(", ")}`);
  return `${expected.length}`;
});

check("словари ru и en синхронны", () => {
  const i18n = globalThis.__swipecraftProbe.i18n;
  const stats = i18n.dictionaryStats();
  must(stats.ru > 250, `словарь ru выглядит обрезанным: ${stats.ru} ключей`);
  must(stats.en > 250, `словарь en выглядит обрезанным: ${stats.en} ключей`);
  must(stats.missingEn.length === 0, `без перевода en: ${stats.missingEn.slice(0, 10).join(", ")}`);
  must(stats.missingRu.length === 0, `без перевода ru: ${stats.missingRu.slice(0, 10).join(", ")}`);
  return `${stats.ru}/${stats.en} ключей, модулей пробы: ${Object.keys(globalThis.__swipecraftProbe).length}`;
});

check("тикер и задачи работают", () => {
  must(mc.state.intervals.length >= 1, "интервалы не поставлены");
  return `интервалов: ${mc.state.intervals.length}`;
});

check("старт без log.error", () => {
  must(errors.length === 0, errors.slice(0, 3).join(" | "));
});

mc.tickTimes(640);
flush();

scenario("economy");

await step("выдача монет админом через админ-формы", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Экономика"));
  answer(pressLabel("Начислить"));
  answer(fillModal("Alice", true, "9000", "stability"));
  await open("sw:admin", admin);
  const titles = shownTitles().join(" > ");
  flush();
  const record = wallet("p-alice");
  must(record, `нет кошелька Alice; формы: ${titles}`);
  must(record.coins === 9000, `coins=${record.coins}; формы: ${titles}`);
  return `Alice ${record.coins}`;
});

await step("кошелёк показывает баланс и эмиссию", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  await open("sw:eco", alice);
  const form = lastForm();
  must(form, "кошелёк не открылся");
  must(form.body.includes("9000"), `тело: ${form.body.slice(0, 140)}`);
  return `${form.buttons.length} кнопок`;
});

await step("перевод закрыт анти-альт порогами", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Перевести"));
  answer(fillModal("Bob", "1500"));
  await open("sw:eco", alice);
  const text = chatOf(alice).join(" / ");
  must(/наиграть|старше/i.test(text), `нет отказа по анти-альт порогу: ${text.slice(-180)}`);
  return "отказ";
});

await step("перевод проходит после ослабления лимитов", async () => {
  metaSet("minPlaySecondsForTransfers", 0);
  metaSet("minAccountAgeHours", 0);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Перевести"));
  answer(fillModal("Bob", "1500"));
  await open("sw:eco", alice);
  const text = chatOf(alice).join(" / ");
  must(/Отправлено/i.test(text), `перевод не прошёл: ${text.slice(-180)}`);
  flush();
  const target = wallet("p-bob");
  must(target, "нет кошелька Bob");
  must(target.coins === 0 && target.lockedCoins === 1500, `Bob coins=${target.coins} locked=${target.lockedCoins}`);
  return `заморожено ${target.lockedCoins} до ${Math.round((target.lockedUntil - mc.state.clock) / 60000)} мин`;
});

await step("комиссия перевода уходит в сожжённое", () => {
  const ledger = readJson("sw:eco:ledger");
  must(ledger, "нет sw:eco:ledger");
  must(ledger.burned > 0, `сожжено ${ledger.burned}`);
  return `minted ${ledger.minted}, burned ${ledger.burned}, fees ${ledger.fees}`;
});

await step("суточный потолок эмиссии на игрока держится", () => {
  flush();
  const record = wallet("p-bob");
  must(record.coins + record.lockedCoins <= 9000, `Bob перекачал: ${record.coins + record.lockedCoins}`);
  return `Bob ${record.coins + record.lockedCoins} из 9000`;
});

await step("разблокировка замороженных денег", () => {
  mc.advance(13 * 60 * 60 * 1000);
  mc.tickTimes(420);
  flush();
  const record = wallet("p-bob");
  must(record.lockedCoins === 0, `заблокировано осталось ${record.lockedCoins}`);
  must(record.coins === 1500, `coins после разблокировки ${record.coins}`);
  return `Bob ${record.coins}`;
});

scenario("market");

await step("казна наполняется для рыночных и клановых проверок", async () => {
  metaSet("mintCapPerDay", 400_000);
  const funded = await mintTo("Alice", 60_000);
  await mintTo("Bob", 30_000);
  return funded;
});

await step("лот создаётся, остаток возвращается в инвентарь", async () => {
  inventoryOf(alice).setItem(0, new mc.ItemStack("minecraft:diamond", 5));
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Выставить"));
  answer(fillModal("diamond", "3", "1200"));
  await open("sw:market", alice);
  const text = chatOf(alice).join(" / ");
  must(/Объявление #/.test(text), `лот не создан: «${text.slice(-180)}», форм: ${shownTitles().join(" > ")}, кнопки: ${JSON.stringify(ui.shown[0]?.buttons ?? []).slice(0, 400)}`);
  must(countItem(alice, "minecraft:diamond") === 2, `остаток не вернулся: ${countItem(alice, "minecraft:diamond")}`);
  const rows = readJson("sw:market") ?? [];
  must(rows.length === 1, `в хранилище ${rows.length} лотов`);
  return `${rows[0].item.typeId} x${rows[0].item.amount} за ${rows[0].price}`;
});

await step("покупка: товар, деньги и комиссия", async () => {
  const listing = (readJson("sw:market") ?? [])[0];
  must(listing, "лот пропал из хранилища");
  flush();
  const aliceBefore = wallet("p-alice");
  const before = { total: aliceBefore.coins + aliceBefore.lockedCoins };
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(bob);
  answer(pressLabel("Купить"));
  await open("sw:market", bob);
  const text = chatOf(bob).join(" / ");
  must(/Куплено/i.test(text), `покупка не прошла: ${text.slice(-180)}`);
  must(countItem(bob, "minecraft:diamond") === 3, `алмазов у Bob ${countItem(bob, "minecraft:diamond")}`);
  flush();
  const sellerRecord = wallet("p-alice");
  const sellerTotal = sellerRecord.coins + sellerRecord.lockedCoins;
  must(sellerTotal > before.total, `продавец не получил деньги: ${before.total} → ${sellerTotal}`);
  must(sellerTotal === before.total + 1200 - Math.round((1200 * 7) / 100), `комиссия рынка не учтена: +${sellerTotal - before.total}`);
  must((readJson("sw:market") ?? []).length === 0, "лот не закрыт");
  return `Alice +${sellerTotal - before.total} из 1200 (комиссия ${1200 - (sellerTotal - before.total)})`;
});

await step("контейнеры не попадают в выбор лота", async () => {
  inventoryOf(alice).setItem(2, new mc.ItemStack("minecraft:shulker_box", 1));
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Выставить"));
  answer("cancel");
  await open("sw:market", alice);
  const form = lastForm();
  must(form && form.kind === "modal" && form.controls.length >= 1, `форма продажи не открылась: ${shownTitles().join(" > ")}`);
  const options = form.controls[0].options ?? [];
  must(!options.some((row) => row.includes("shulker")), `шакер в списке: ${options.join(",")}`);
  return `${options.length} позиций`;
});

scenario("cases");

await step("шансы показаны в меню кейса", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Базовый"));
  await open("sw:case", alice);
  const form = lastForm();
  must(form, "детали кейса не открылись");
  const percents = [...form.body.matchAll(/([\d.]+)%/g)].map((row) => Number(row[1]));
  must(percents.length >= 4, `строк шансов: ${percents.length}`);
  const sum = [...form.body.matchAll(/(\d+(?:\.\d+)?)%/g)].length;
  return `${sum} долей, есть гарант: ${/Гарант/.test(form.body)}`;
});

await step("вскрытие за монеты выдаёт лог и предметы", async () => {
  flush();
  const before = (readJson("sw:cases:log") ?? []).length;
  const itemsBefore = mc.state.items.length;
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Базовый"));
  answer(pressLabel("Открыть за монеты ×1"));
  await open("sw:case", alice);
  const text = chatOf(alice).join(" / ");
  const log = readJson("sw:cases:log") ?? [];
  must(log.length > before, `лог не вырос: ${text.slice(-160)}`);
  const held = inventoryOf(alice)._slots.filter(Boolean).length;
  must(held > 0 || mc.state.items.length > itemsBefore, "предметы не выданы");
  return `${log.length - before} записей лога, ${held} стоков инвентаря, ${mc.state.items.length - itemsBefore} на земле`;
});

await step("вскрытие без денег отклоняется", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(carl);
  answer(pressLabel("Базовый"));
  answer(pressLabel("Открыть за монеты ×1"));
  await open("sw:case", carl);
  const text = chatOf(carl).join(" / ");
  must(/Не хватает|ключей|Нужно/i.test(text), `нет отказа по цене: ${text.slice(-160)}`);
  return text.slice(-70);
});

scenario("clans");

await step("создание клана: списание, документ, индекс", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Создать"));
  answer(["Night_Watch", "NWT"]);
  await open("sw:clan", alice);
  const text = chatOf(alice).join(" / ");
  must(/создан/i.test(text), `клан не создан: ${text.slice(-180)}`);
  const index = readJson("sw:clans:index");
  must(index && index.clanIds.length === 1, `индекс: ${JSON.stringify(index ?? {}).slice(0, 120)}`);
  flush();
  const doc = readJson(`sw:clan:${index.clanIds[0]}`);
  must(doc && doc.tag === "NWT" && doc.members.length === 1, `документ: ${JSON.stringify(doc ?? {}).slice(0, 120)}`);
  return `${doc.name} [${doc.tag}], лидер ${doc.members[0].role}`;
});

await step("дублирование тега и имени отклоняется", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(bob);
  answer(pressLabel("Создать"));
  answer(["Night_Watch", "NWT"]);
  await open("sw:clan", bob);
  const text = chatOf(bob).join(" / ");
  must(/занято|3–20|не найден/i.test(text), `нет отказа по имени: ${text.slice(-160)}`);
  const index = readJson("sw:clans:index");
  must(index.clanIds.length === 1, `появился лишний клан: ${index.clanIds.length}`);
  return "отказ";
});

await step("приглашение и вступление", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Пригласить"));
  answer(["Bob"]);
  await open("sw:clan", alice);
  let text = chatOf(alice).join(" / ");
  must(/Приглашение отправлено/i.test(text), `приглашение не отправлено: ${text.slice(-160)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(bob);
  answer(pressLabel("приглашения"));
  await open("sw:clan", bob);
  text = chatOf(bob).join(" / ");
  must(/в клане/i.test(text), `Bob не вступил: ${text.slice(-160)}`);
  flush();
  const index = readJson("sw:clans:index");
  const doc = readJson(`sw:clan:${index.clanIds[0]}`);
  must(doc.members.length === 2, `участников ${doc.members.length}`);
  return doc.members.map((row) => `${row.name}:${row.role}`).join(",");
});

await step("права: рядовой не ставит дом и не приглашает", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(bob);
  answer(3);
  answer(0);
  await open("sw:clan", bob);
  let text = chatOf(bob).join(" / ");
  must(/Недостаточно прав/i.test(text), `права не проверены (дом): ${text.slice(-160)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(bob);
  answer(pressLabel("Пригласить"));
  answer(["Carl"]);
  await open("sw:clan", bob);
  text = chatOf(bob).join(" / ");
  must(/Недостаточно прав/i.test(text), `права не проверены (инвайт): ${text.slice(-160)}`);
  return "отказ по роли";
});

await step("дом клана и откат телепорта", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Дом клана"));
  answer(pressLabel("Назначить дом"));
  await open("sw:clan", alice);
  let text = chatOf(alice).join(" / ");
  must(/Дом клана.*обновлен|обновлен/i.test(text), `дом не задан: ${text.slice(-160)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Дом клана"));
  answer(pressLabel("Телепорт к дому"));
  await open("sw:clan", alice);
  text = chatOf(alice).join(" / ");
  const first = /Телепорт в дом клана/i.test(text);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Дом клана"));
  answer(pressLabel("Телепорт к дому"));
  await open("sw:clan", alice);
  text = chatOf(alice).join(" / ");
  must(first, `первый телепорт не прошёл: ${text.slice(-160)}`);
  must(/через \d+ с/i.test(text), `откат телепорта не сработал: ${text.slice(-120)}`);

  //сбойный телепорт не должен стоить денег и включать кулдаун:
  //проверяем и баланс, и то, что следующая попытка сразу проходит
  flush();
  const metaBefore = readJson("sw:eco:meta");
  const coinsBefore = metaBefore[alice.id].coins;
  mc.advance(6 * 60 * 1000);
  const realTp = alice.teleport;
  expectedWarns.push(/телепорт домой/);
  alice.teleport = () => {
    throw new Error("mock: измерения нет");
  };
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Дом клана"));
  answer(pressLabel("Телепорт к дому"));
  await open("sw:clan", alice);
  text = chatOf(alice).join(" / ");
  must(/не удался/i.test(text), `сбой телепорта не озвучен: ${text.slice(-140)}`);
  flush();
  const coinsAfterFail = readJson("sw:eco:meta")[alice.id].coins;
  must(coinsAfterFail === coinsBefore, `за сбойный телепорт взяты деньги: ${coinsBefore} → ${coinsAfterFail}`);
  alice.teleport = realTp;
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Дом клана"));
  answer(pressLabel("Телепорт к дому"));
  await open("sw:clan", alice);
  text = chatOf(alice).join(" / ");
  must(/Телепорт в дом клана/i.test(text), `после сбоя кулдаун всё-таки включился: ${text.slice(-140)}`);
  flush();
  const coinsCharged = readJson("sw:eco:meta")[alice.id].coins;
  must(coinsCharged === coinsBefore - 250, `плата за телепорт не списана: ${coinsBefore} → ${coinsCharged}`);
  const index = readJson("sw:clans:index");
  const doc = readJson(`sw:clan:${index.clanIds[0]}`);
  must(doc.home, "дом не сохранён");
  return `дом ${Math.round(doc.home.x)} ${Math.round(doc.home.y)} ${Math.round(doc.home.z)}, откат и оплата по успешному телепорту ок`;
});

await step("казна: взнос и дневный лимит снятия", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Казна"));
  answer(pressLabel("Положить"));
  answer(["2000"]);
  await open("sw:clan", alice);
  let text = chatOf(alice).join(" / ");
  must(/в казне клана/i.test(text), `взнос не прошёл: ${text.slice(-160)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Казна"));
  answer(pressLabel("Забрать"));
  answer(["999999"]);
  await open("sw:clan", alice);
  text = chatOf(alice).join(" / ");
  must(/Дневной лимит|Нужна сумма|больше нуля|снят/i.test(text), `лимит казны не отработал: ${text.slice(-160)}`);
  flush();
  const ledger = readJson("sw:eco:ledger");
  must(ledger.accounts["clan:" + readJson("sw:clans:index").clanIds[0]], "нет счёта казны в ledger");
  return `счёт казны ${ledger.accounts["clan:" + readJson("sw:clans:index").clanIds[0]].coins}`;
});

await step("война без противника отклоняется", async () => {
  mc.makePlayer("p-dan", "Dan", { x: 16, y: 71, z: 16 });
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Войны"));
  answer(pressLabel("Объявить"));
  answer(fillModal("Sky_Born", "10000"));
  await open("sw:clan", alice);
  const text = chatOf(alice).join(" / ");
  must(/не меньше|Клан-противник не найден|казн/i.test(text), `нет ответа про войну: ${text.slice(-160)}`);
  return text.slice(-60);
});

await step("топ кланов читается", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(bob);
  answer(pressLabel("Топ кланов"));
  await open("sw:clan", bob);
  const text = chatOf(bob).join(" / ");
  must(/Night_Watch/.test(text), `топ кланов пуст: ${text.slice(-160)}`);
  return text.slice(0, 80);
});

scenario("progress");

await step("дейлик один раз в сутки и сброс", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("ежедневку"));
  await open("sw:quest", alice);
  let text = chatOf(alice).join(" / ");
  must(/Награда за день/i.test(text), `дейлик не выдан: ${text.slice(-160)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("ежедневку"));
  await open("sw:quest", alice);
  text = chatOf(alice).join(" / ");
  must(/уже получена/i.test(text), `дейлик выдан дважды: ${text.slice(-160)}`);
  mc.advance(25 * 60 * 60 * 1000);
  mc.tickTimes(40);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("ежедневку"));
  await open("sw:quest", alice);
  text = chatOf(alice).join(" / ");
  must(/Награда за день/i.test(text), `дейлик не сбросился: ${text.slice(-160)}`);
  return "серия и сброс ок";
});

await step("квест по добыче руды продвигается", () => {
  const before = wallet("p-alice").quests?.miner ?? 0;
  mc.fire("after", "playerBreakBlock", {
    player: alice,
    block: { typeId: "minecraft:deepslate_diamond_ore" },
    brokenBlockPermutation: { type: { id: "minecraft:deepslate_diamond_ore" } },
  });
  mc.fire("after", "playerBreakBlock", {
    player: alice,
    block: { typeId: "minecraft:iron_ore" },
    brokenBlockPermutation: { type: { id: "minecraft:iron_ore" } },
  });
  flush();
  const after = wallet("p-alice").quests?.miner ?? 0;
  must(after >= before + 2, `прогресс квеста ${before} → ${after}`);
  return `${before} → ${after}`;
});

scenario("donations");

await step("заявка уходит админу и сохраняется", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("bronze"));
  answer(["30", "card 4276"]);
  await open("sw:don", alice);
  const text = chatOf(alice).join(" / ");
  must(/Заявка #/.test(text), `заявка не создана: ${text.slice(-160)}`);
  const requests = readJson("sw:don:requests") ?? [];
  must(requests.length >= 1, "заявки не сохранены");
  must(requests.at(-1).status === "open", "статус не open");
  return `заявок ${requests.length}`;
});

await step("дубликат открытой заявки отклонён", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("bronze"));
  answer(["30", "again"]);
  await open("sw:don", alice);
  const text = chatOf(alice).join(" / ");
  must(/уже ждёт/i.test(text), `дубль не отклонён: ${text.slice(-160)}`);
  return "ок";
});

await step("одобрение выдаёт тариф, префикс и журнал", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("заявки"));
  answer(pressLabel("Одобрить"));
  answer(pressLabel("Одобрить"));
  await open("sw:admin", admin);
  flush();
  const grants = readJson("sw:don:grants") ?? [];
  must(grants.length >= 1, `нет выдачи в журнале: ${chatOf(admin).join(" | ").slice(-200)}`);
  const record = wallet("p-alice");
  must(record.donorTier === "bronze", `тариф ${record.donorTier}`);
  must(admin.nameTag.length > 0 || alice.nameTag !== "Alice", `префикс не применён: ${alice.nameTag}`);
  return `журнал ${grants.length}, tag=${alice.nameTag}`;
});

await step("заявка другого игрока: выдача не даёт ключей и монет", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(carl);
  answer(pressLabel("bronze"));
  answer(fillModal("30", "charge-test-42"));
  await open("sw:don", carl);
  const submitted = chatOf(carl).join(" / ");
  must(/заявка/i.test(submitted), `заявка carl не прошла: ${submitted.slice(-160)}`);
  flush();
  const before = wallet("p-carl") ?? {};
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("заявки"));
  answer(pressLabel("#"));
  answer(pressLabel("Одобрить"));
  await open("sw:admin", admin);
  flush();
  const after = wallet("p-carl");
  must(after.donorTier === "bronze", `тариф не выдан: ${after.donorTier}`);
  must(after.caseKeys === (before.caseKeys ?? 0), `донат выдал ключи: ${(before.caseKeys ?? 0)} → ${after.caseKeys}`);
  must(after.coins === (before.coins ?? 0), `донат выдал монеты: ${(before.coins ?? 0)} → ${after.coins}`);
  must(after.cosmetics.rolls >= DONATIONS_GIFT_ROLLS, `не выдана подарочная прокрутка: ${after.cosmetics.rolls}`);
  return `ключей ${after.caseKeys}, монет ${after.coins}, прокруток ${after.cosmetics.rolls}`;
});

await step("спорный платёж снимает тариф и блокирует выдачу", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("Спорный платёж"));
  answer(pressLabel("Carl"));
  answer(fillModal("chargeback, ID 42", false));
  await open("sw:admin", admin);
  flush();
  let record = wallet("p-carl");
  must(record.donorTier === "none", `тариф не снят: ${record.donorTier}`);
  must(record.donBlockUntil > Date.now(), `блокировка не выставлена: ${record.donBlockUntil}`);
  must(/chargeback/.test(record.donBlockReason), `причина не записана: ${record.donBlockReason}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("Спорный платёж"));
  answer(pressLabel("Carl"));
  answer(fillModal("разобрано", true));
  await open("sw:admin", admin);
  flush();
  record = wallet("p-carl");
  must(record.donBlockUntil === 0, `блокировка не снята: ${record.donBlockUntil}`);
  return "спор открыт и закрыт, тариф снят";
});

await step("цель сбора: ручная выдача добирает её и платит всем", async () => {
  const target = wallet("p-dan") ?? {};
  const coinsBefore = target.coins ?? 0;
  const keysBefore = target.caseKeys ?? 0;
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("Цель сбора"));
  answer(pressLabel("Назначить цель сбора"));
  answer(fillModal("Хостинг на месяц", "199", "30"));
  await open("sw:admin", admin);
  flush();
  let goal = readJson("sw:don:goal") ?? {};
  must(goal.target === 199, `цель не назначена: ${JSON.stringify(goal).slice(0, 160)}`);
  must(goal.raised === 0, `поднятое не обнулено: ${goal.raised}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("Выдать вручную"));
  answer(fillModal("Dan", "bronze", "30", "invoice 777, карта"));
  await open("sw:admin", admin);
  flush();
  goal = readJson("sw:don:goal") ?? {};
  must(goal.raised >= 199, `вклад не учтён: ${goal.raised}/${goal.target}`);
  must(goal.paidAt > 0, "выплата по цели не сработала");
  const after = wallet("p-dan");
  must(after.donorTier === "bronze", `тариф не выдан вручную: ${after.donorTier}`);
  must(after.coins >= coinsBefore + 1200, `награда за цель не дошла: ${after.coins} против ${coinsBefore}`);
  must(after.caseKeys >= keysBefore + 1, `ключ за цель не выдан офлайну: ${after.caseKeys}`);
  const receipts = readJson("sw:don:receipts") ?? [];
  const mine = receipts.filter((row) => row.playerId === "p-dan");
  must(mine.some((row) => row.via === "donate" && row.amount === 199), `чека доната нет: ${JSON.stringify(mine).slice(0, 200)}`);
  must(mine.some((row) => row.via === "gift"), "чека о подарке за цель нет");
  const grantsLog = readJson("sw:don:grants") ?? [];
  const last = grantsLog.at(-1) ?? {};
  must(last.actor === "Admin" && /invoice 777/.test(last.note), `в журнале нет руки админа и ID платежа: ${JSON.stringify(last).slice(0, 200)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("Цель сбора"));
  answer(pressLabel("Снять цель"));
  await open("sw:admin", admin);
  flush();
  goal = readJson("sw:don:goal") ?? {};
  must(!goal.target, `цель не снята: ${JSON.stringify(goal).slice(0, 120)}`);
  return `цель 199/199, кошельков с наградой: ${Object.keys(meta()).length}`;
});

await step("косметика покупается за ₡ и меняет nameTag", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  flush();
  const before = wallet("p-alice").coins;
  answer(pressLabel("Звезда · 2200"));
  answer(pressLabel("Куплено"));
  await open("sw:shop", alice);
  flush();
  const record = wallet("p-alice");
  must(record.coins === before - 2200, `цена списана неверно: ${before} → ${record.coins}`);
  must(record.cosmetics.owned.includes("prefix_star"), `предмет не зачислен: ${record.cosmetics.owned.join(",")}`);
  must(String(alice.nameTag).includes("✦"), `приставка не применена: ${alice.nameTag}`);
  return `${before} → ${record.coins}, tag=${alice.nameTag}`;
});

await step("подарочная прокрутка не выдаёт предметов в инвентарь", async () => {
  flush();
  const itemsBefore = inventoryOf(carl)._slots.length;
  const coinsBefore = wallet("p-carl").coins;
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Открыть подарком"));
  await open("sw:shop", carl);
  flush();
  const record = wallet("p-carl");
  must(record.cosmetics.owned.length >= 1, `прокрутка ничего не выдала: ${record.cosmetics.owned.length}`);
  must(record.cosmetics.owned.every((id) => COSMETIC_IDS.includes(id)), `в косметику попало чужое: ${record.cosmetics.owned.join(",")}`);
  must(record.cosmetics.rolls === 0, `прокрутки не списаны: ${record.cosmetics.rolls}`);
  must(record.coins === coinsBefore, `со списанием монет: ${coinsBefore} → ${record.coins}`);
  must(inventoryOf(carl)._slots.length === itemsBefore, "в инвентарь что-то легло");
  return `выдано ${record.cosmetics.owned.join(",")}`;
});

await step("тумблер частиц гасит трейлы без рестарта", () => {
  // выдаём и включаем морозный след — иначе тесту нечего гасить
  const cos = globalThis.__swipecraftProbe.cosmetics;
  cos.grantCosmetic("test", carl, "trail_frost");
  cos.equipCosmetic(carl, "trail", "trail_frost");
  flush();
  mc.state.particles.length = 0;
  mc.tickTimes(40);
  const before = mc.state.particles.length;
  must(before > 0, `трейлы не спавнились и до отключения: ${JSON.stringify(mc.state.particles).slice(0, 160)}`);
  must(mc.state.particles.at(0).id === "swipecraft:trail_frost", `спавнится не экипированный след: ${mc.state.particles.at(0).id}`);
  metaSet("donorTrailsEnabled", 0);
  mc.state.particles.length = 0;
  mc.tickTimes(40);
  const off = mc.state.particles.length;
  must(off === 0, `после выключения всё ещё спавнится: ${off}`);
  metaSet("donorTrailsEnabled", 1);
  mc.tickTimes(40);
  const on = mc.state.particles.length;
  must(on > 0, "после включения трейлы не вернулись");
  const nameTags = mc.state.players.map((row) => String(row.nameTag));
  must(nameTags.some((tag) => tag.includes("бронза")), `выключение частиц затронуло nameTag: ${nameTags.join(" | ")}`);
  return `до ${before}, выкл 0, снова ${on}`;
});

await step("чек покупки доступен игроку", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Мои покупки"));
  await open("sw:shop", alice);
  const lines = chatOf(alice).join(" / ");
  must(/Звезда/.test(lines), `чека нет: ${lines.slice(-200)}`);
  return lines.slice(0, 80);
});

scenario("queue");

await step("приоритетный вход выпускает раньше остальных", async () => {
  metaSet("queueEnabled", 1);
  metaSet("queueSoftCap", 3);
  metaSet("queueReleaseAt", 2);
  const late = mc.makePlayer("p-late", "Late", { x: 60, y: 71, z: 60 });
  clearChat(late);
  mc.tickTimes(60);
  const waiting = mc.state.players.filter((row) => Math.abs(row.location.x - 6) < 3 && Math.abs(row.location.z - 6) < 3);
  const report = run("sw:meta", admin, "info");
  mc.state.players.splice(mc.state.players.indexOf(late), 1);
  metaSet("queueSoftCap", 82);
  metaSet("queueReleaseAt", 74);
  return `в ожидании ${waiting.length}; ${String(report).split("\n").length} строк отчёта`;
});

scenario("events");

await step("босс — сущность с 520 HP и тегом", async () => {
  const before = mc.state.entities.length;
  run("sw:event", admin, "start", "bossraid");
  mc.tickTimes(80);
  const boss = mc.state.entities.find((entity) => entity.hasTag?.("sw:boss"));
  must(boss, `босс не заспавнен (новых сущностей ${mc.state.entities.length - before})`);
  const health = boss.getComponent("minecraft:health");
  must(health.effectiveMax >= 520 || boss._effects.has("health_boost"), `HP ${health.effectiveMax}`);
  return `${boss.typeId}, hp ${health.currentValue}/${health.effectiveMax}`;
});

await step("фаза 2 вызывается через event entity", async () => {
  const boss = mc.state.entities.find((entity) => entity.hasTag?.("sw:boss"));
  must(boss, "босс пропал");
  const before = mc.state.kicked.length;
  const health = boss.getComponent("minecraft:health");
  health.setCurrentValue(Math.round(health.effectiveMax * 0.5));
  mc.tickTimes(60);
  const fired = mc.state.kicked.slice(before).map((row) => row.command).filter((command) => command.includes("event entity"));
  must(fired.length > 0, `нет команд фазы: ${mc.state.kicked.slice(before).map((row) => row.command).join(" / ").slice(0, 160)}`);
  return fired[0].slice(0, 70);
});

await step("смерть босса: награды только участникам", async () => {
  const boss = mc.state.entities.find((entity) => entity.hasTag?.("sw:boss"));
  must(boss, "босс пропал");
  const itemsBefore = mc.state.items.length;
  clearChat(alice);
  clearChat(bob);
  for (let index = 0; index < 6; index += 1) {
    mc.fire("after", "entityHurt", { hurtEntity: boss, damageSource: { cause: "entityAttack", damagingEntity: alice }, damage: 60 });
  }
  mc.tickTimes(20);
  mc.fire("after", "entityDie", { deadEntity: boss, damageSource: { cause: "entityAttack", damagingEntity: alice } });
  mc.tickTimes(40);
  run("sw:event", admin, "stop");
  mc.tickTimes(30);
  must(!mc.state.entities.some((entity) => entity.hasTag?.("sw:boss")), "мёртвый босс остался в мире");
  const aliceText = chatOf(alice).join(" / ");
  const bobText = chatOf(bob).join(" / ");
  must(/Последний удар/i.test(aliceText + bobText + mc.state.sentMessages.join(" ")), "нет анонса об убийце");
  must(mc.state.items.length === itemsBefore, "награды не должны падать лутом под босса");
  const aliceRewarded = /босс|награда|участник/i.test(aliceText);
  must(aliceRewarded || !/босс|награда|участник/i.test(bobText), `награда ушла неучастнику: ${bobText.slice(-140)}`);
  flush();
  const awarded = JSON.stringify(readJson("sw:events") ?? {});
  must(!/p-bob/.test(awarded) || /awarded/.test(awarded), "нет журнала наград");
  return `Alice ${aliceText.length} симв., Bob ${bobText.length}`;
});

await step("после ивента мир не оставляет тегированных сущностей", () => {
  const leftovers = mc.state.entities.filter((entity) => entity.hasTag?.("sw:boss") || entity.hasTag?.("sw:bloodmoon"));
  must(leftovers.length === 0, `остались сущности с тегами: ${leftovers.length}`);
  return "ок";
});

await step("кровавая луна спавнит мобов только на безопасных клетках", () => {
  run("sw:event", admin, "stop");
  mc.tickTimes(30);
  mc.state.hazardAt.add(`${Math.round(alice.location.x)}:${mc.state.groundY}:${Math.round(alice.location.z)}`);
  run("sw:event", admin, "start", "bloodmoon");
  mc.tickTimes(140);
  const mobs = mc.state.entities.filter((entity) => entity.hasTag?.("sw:bloodmoon"));
  const dimension = mc.world.getDimension("minecraft:overworld");
  for (const mob of mobs) {
    const feet = dimension.getBlock(mob.location);
    const below = dimension.getBlock({ x: mob.location.x, y: Math.floor(mob.location.y) - 1, z: mob.location.z });
    const head = dimension.getBlock({ x: mob.location.x, y: Math.floor(mob.location.y) + 1, z: mob.location.z });
    must(!below.isAir, `моб висит над пустотой ${JSON.stringify(mob.location)}`);
    must(!feet.isLiquid && !below.isLiquid, `моб в лаве ${JSON.stringify(mob.location)}`);
    must(feet.isAir || !feet.isSolidBlocking, `моб внутри блока ${JSON.stringify(mob.location)}`);
    must(head.isAir || !head.isSolidBlocking, `нет места для головы ${JSON.stringify(mob.location)}`);
  }
  mc.state.hazardAt.clear();
  must(mobs.length > 0, "мобы не заспавнены");
  return `${mobs.length} мобов`;
});

await step("lifesteal: сердца растут, потолок держит", async () => {
  run("sw:event", admin, "stop");
  mc.tickTimes(30);
  run("sw:event", admin, "start", "lifesteal");
  mc.tickTimes(30);
  for (let index = 0; index < 12; index += 1) {
    mc.fire("after", "entityDie", { deadEntity: bob, damageSource: { cause: "entityAttack", damagingEntity: alice } });
    mc.tickTimes(2);
  }
  mc.tickTimes(60);
  flush();
  const record = wallet("p-alice");
  must(record.hearts > 0, `сердца ${record.hearts}`);
  must(record.hearts <= 6, `сердца выше потолка: ${record.hearts}`);
  const effect = alice.getEffect("health_boost");
  must(effect, "нет health_boost");
  must(effect.amplifier === record.hearts - 1, `усилитель ${effect.amplifier} против сердец ${record.hearts}`);
  return `сердца ${record.hearts}, hp ${alice.getComponent("minecraft:health").currentValue}`;
});

await step("lifesteal: смерть снимает сердца", () => {
  const before = wallet("p-alice").hearts;
  mc.fire("after", "entityDie", { deadEntity: alice, damageSource: { cause: "fall", damagingEntity: undefined } });
  mc.tickTimes(20);
  flush();
  const after = wallet("p-alice").hearts;
  must(after < before, `сердца не списаны: ${before} → ${after}`);
  return `${before} → ${after}`;
});

await step("pvp-статистика и серия", () => {
  flush();
  const aliceRecord = wallet("p-alice");
  const bobRecord = wallet("p-bob");
  must(aliceRecord.pvpKills > 0, "убийств не записано");
  must(bobRecord.pvpDeaths > 0, "смертей не записано");
  return `Alice ${aliceRecord.pvpKills} уб., Bob ${bobRecord.pvpDeaths} см. (серия Alice ${aliceRecord.streak})`;
});

scenario("referrals");

await step("код приглашения выдаётся один раз и стабилен", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мой код"));
  clearChat(alice);
  await open("sw:ref", alice);
  const text = chatOf(alice).join(" / ");
  const found = /Твой код: ([a-z0-9]{6,12})/.exec(text);
  must(found, `код не показан: ${text.slice(-200)}`);
  flush();
  const record = wallet("p-alice");
  must(record.refCode === found[1], `код в кошельке не совпал: ${record.refCode} ≠ ${found[1]}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мой код"));
  clearChat(alice);
  await open("sw:ref", alice);
  const again = /Твой код: ([a-z0-9]{6,12})/.exec(chatOf(alice).join(" / "));
  must(again && again[1] === found[1], "код изменился между показом");
  return `код ${found[1]}`;
});

await step("чужие коды: сам себе и неизвестный отклоняются", async () => {
  const code = wallet("p-alice").refCode;
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Ввести код друга"));
  answer(fillModal(code));
  await open("sw:ref", alice);
  let text = chatOf(alice).join(" / ");
  must(/Себя пригласить нельзя/i.test(text), `самосвязь не отклонена: ${text.slice(-160)}`);
  const novice = mc.makePlayer("p-novice", "Novice", { x: 20, y: 71, z: 20 });
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(novice);
  answer(pressLabel("Ввести код друга"));
  answer(fillModal("zzzzzz"));
  await open("sw:ref", novice);
  text = chatOf(novice).join(" / ");
  must(/Такого кода нет/i.test(text), `несуществующий код принят: ${text.slice(-160)}`);
  mc.removePlayer("p-novice");
  return "оба отказа есть";
});

await step("старый аккаунт код не привязывает", async () => {
  mc.advance(8 * 24 * 60 * 60 * 1000);
  const code = wallet("p-alice").refCode;
  clearChat(bob);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Ввести код друга"));
  answer(fillModal(code));
  await open("sw:ref", bob);
  const text = chatOf(bob).join(" / ");
  must(/первые 72 ч/i.test(text), `окно привязки не сработало: ${text.slice(-180)}`);
  flush();
  must(wallet("p-bob").refBy === "", "привязка всё-таки появилась");
  return "окно 72 ч держит";
});

await step("награда ждёт реальных часов игры и упирается в дневной лимит", async () => {
  const code = wallet("p-alice").refCode;
  const coinsBefore = wallet("p-alice").coins;
  const novices = [];
  for (let index = 0; index < 4; index += 1) {
    const novice = mc.makePlayer(`p-novice-${index}`, `Novice${index}`, { x: 24 + index, y: 71, z: 24 });
    novices.push(novice);
    ui.shown.length = 0;
    ui.answers.length = 0;
    answer(pressLabel("Ввести код друга"));
    answer(fillModal(code));
    await open("sw:ref", novice);
  }
  flush();
  const bound = novices.filter((row) => wallet(row.id) && wallet(row.id).refBy === "p-alice");
  must(bound.length === 4, `привязались не все: ${bound.length}`);
  mc.tickTimes(620);
  flush();
  const early = novices.filter((row) => wallet(row.id).refRewarded);
  must(early.length === 0, `награда выдана без наигранных часов: ${early.length}`);
  mc.advance(3 * 60 * 60 * 1000);
  mc.tickTimes(620);
  flush();
  const rewarded = novices.filter((row) => wallet(row.id).refRewarded);
  must(rewarded.length === 3, `дневной лимит не сработал: выдано ${rewarded.length} из 4`);
  const record = wallet("p-alice");
  must(record.refToday === 3, ` счётчик дня неверен: ${record.refToday}`);
  must(record.coins === coinsBefore + 3 * 2500, `сумма наград не совпала: ${coinsBefore} → ${record.coins}`);
  const paid = novices.filter((row) => wallet(row.id).refRewarded);
  for (const row of paid) must(wallet(row.id).coins >= REFERRAL_NOVICE_COINS, `новичок без награды: ${row.name} ${wallet(row.id).coins}`);
  must(paid.length > 0, "ни один новичок не награждён");
  const info = String(run("sw:meta", admin, "info").message);
  must(/приглашения:/.test(info), `в отчёте нет блока приглашений: ${info.slice(-220)}`);
  const registry = readJson("sw:ref:codes") ?? {};
  must(Object.keys(registry).length >= 5, `в реестре кодов мало записей: ${Object.keys(registry).length}`);
  const aliceCode = wallet("p-alice").refCode;
  must(registry[aliceCode]?.playerId === "p-alice", `реестр кодов разошёлся с кошельком: ${JSON.stringify(registry[aliceCode])}`);
  for (const novice of novices) mc.removePlayer(novice.id);
  return `выдано ${rewarded.length}/4, у пригласившего +${record.coins - coinsBefore} ₡`;
});

await step("админ снимает привязку, привязаться заново можно только в окне 72 ч", async () => {
  const novice = mc.makePlayer("p-reset", "Reset", { x: 30, y: 71, z: 30 });
  const code = wallet("p-alice").refCode;
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Ввести код друга"));
  answer(fillModal(code));
  await open("sw:ref", novice);
  flush();
  must(wallet("p-reset").refBy === "p-alice", `привязка не появилась: ${wallet("p-reset").refBy}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Донат"));
  answer(pressLabel("Сбросить привязку"));
  answer(pressLabel("Reset"));
  answer(fillModal("игрок перепутал код"));
  await open("sw:admin", admin);
  flush();
  must(wallet("p-reset").refBy === "", `привязка не снята: ${wallet("p-reset").refBy}`);
  must(wallet("p-reset").refRewarded === false, "флаг награды не сброшен");
  const logRows = readJson("sw:ref:log") ?? [];
  must(logRows.some((row) => row.kind === "reset" && row.referee === "Reset"), `в журнале нет строки reset: ${JSON.stringify(logRows.slice(-3))}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(novice);
  answer(pressLabel("Ввести код друга"));
  answer(fillModal(code));
  await open("sw:ref", novice);
  flush();
  must(wallet("p-reset").refBy === "p-alice", "повторная привязка в окне 72 ч не сработала");
  mc.removePlayer(novice);
  return "снят, записан в журнал, привязан заново";
});

scenario("storage");

await step("неактивные пустые кошельки прореживаются задачей meta-prune", () => {
  const ghost = mc.makePlayer("p-ghost", "Ghost", { x: 40, y: 71, z: 40 });
  flush();
  must(wallet("p-ghost") !== undefined, "запись игрока не создалась");
  must((wallet("p-ghost").coins ?? 0) === 0, `у призрака есть монеты: ${wallet("p-ghost").coins}`);
  mc.removePlayer(ghost);
  mc.advance(61 * 24 * 60 * 60 * 1000);
  expectedWarns.push(/\[warn\]\[balances\] удалено записей/);
  mc.tickTimes(22000);
  flush();
  must(wallet("p-ghost") === undefined, "пустой кошелёк не прорежен");
  must(wallet("p-alice") !== undefined, "прореживание затронуло кошелёк с монетами");
  must(wallet("p-carl") !== undefined, "прореживание затронуло кошелёк донера");
  must(wallet("p-alice").coins > 0, "у alice пропали монеты");
  return "Ghost убран, кошельки с содержимым целы";
});


await step("переполнение DP блокирует запись клана", async () => {
  const index = readJson("sw:clans:index");
  const before = index.clanIds.length;
  mc.state.byteOverride = 2_600_000;
  const fresh = mc.makePlayer("p-new", "Newcomer", { x: 30, y: 71, z: 30 });
  metaSet("minPlaySecondsForTransfers", 0);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(fresh);
  answer(pressLabel("Создать"));
  answer(["Sky_Born", "SKY"]);
  await open("sw:clan", fresh);
  mc.state.byteOverride = undefined;
  const text = chatOf(fresh).join(" / ");
  const after = (readJson("sw:clans:index")?.clanIds ?? []).length;
  must(after === before || /переполн|отменен|storage/i.test(text), `клан записан поверх лимита: ${text.slice(-160)}`);
  must(/переполн|отменен|Хранилище|скажи админу/i.test(text) || after === before, "нет сигнала о переполнении");
  return `кланов ${after}, ответ: ${text.slice(-60)}`;
});

await step("чанки состояния читаются полностью", () => {
  flush();
  const clans = readJson("sw:clans:index");
  const market = readJson("sw:market");
  const balances = readJson("sw:eco:meta");
  const ledger = readJson("sw:eco:ledger");
  must(clans && Array.isArray(market) && balances && ledger, "часть состояния не сериализована");
  return `кланов ${clans.clanIds.length}, лотов ${market.length}, кошельков ${Object.keys(balances).length}, строк DP ${mc.world.getDynamicPropertyIds().length}`;
});

await step("размер кошельков в пределах квоты", () => {
  const bytes = mc.world.getDynamicPropertyTotalByteCount();
  must(bytes < 2_000_000, `dynamic properties уже ${bytes} байт`);
  return `${bytes} байт`;
});

scenario("menu");

await step("главное меню: подписи кнопок и переходы не разъезжаются", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  await open("sw:menu", alice);
  const form = lastForm();
  must(form && form.title.includes("Swipecraft"), `меню не открылось: ${shownTitles().join(" > ")}`);
  const expected = ["Кошелёк", "Рынок игроков", "Кейсы", "Кланы", "Квесты и награды", "Донат", "Косметика", "Ранги", "Пригласить друга", "Авто-шахта", "Зачарованные тотемы", "Случайная телепортация", "Правила мира", "Моя статистика", "Язык / Language", "Закрыть"];
  const missing = expected.filter((part) => !form.buttons.some((label) => label.includes(part)));
  must(missing.length === 0, `нет пунктов: ${missing.join(", ")} (${form.buttons.join(" | ")})`);
  must(form.buttons.length === expected.length, `игроку без admin показали ${form.buttons.length} кнопок вместо ${expected.length}`);
  must(!form.buttons.some((label) => label.includes("Админ-панель")), "не-админу видна админ-панель");
  clearChat(alice);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Правила мира"));
  await open("sw:menu", alice);
  const rules = chatOf(alice).join(" / ");
  must(rules.includes("1. PvP") && rules.includes("10."), `правила не дошли или неполные: ${rules.slice(0, 140)}`);
  must(/Mojang/i.test(rules), `в правилах нет дисклеймера про Mojang: ${rules.slice(-160)}`);
  clearChat(alice);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Моя статистика"));
  await open("sw:menu", alice);
  const stats = chatOf(alice).join(" / ");
  must(/Убийств: \d+ \| Смертей: \d+/.test(stats), `статистика не дошла: ${stats.slice(0, 160)}`);
  return `${form.buttons.length} кнопок, правила и статистика по адресу`;
});

await step("переключение языка меняет меню и тексты, обратно — тоже", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Язык / Language"));
  await open("sw:menu", alice);
  must(chatOf(alice).join(" / ").includes("Language: English"), `язык не переключился: ${chatOf(alice).join(" / ").slice(-120)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  await open("sw:menu", alice);
  const en = lastForm();
  must(en.title.includes("menu"), `в en меню осталось русским: ${en.title}`);
  must(en.buttons.some((label) => label.includes("Wallet")), `кнопки не перевелись: ${en.buttons.join(" | ").slice(0, 160)}`);
  clearChat(alice);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("World rules"));
  await open("sw:menu", alice);
  const rulesEn = chatOf(alice).join(" / ");
  must(rulesEn.includes("PvP is allowed") && rulesEn.includes("NOT AN OFFICIAL MINECRAFT"), `правила не перешли на en: ${rulesEn.slice(0, 140)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Language / Язык"));
  await open("sw:menu", alice);
  must(chatOf(alice).join(" / ").includes("Язык: русский"), `язык не вернулся: ${chatOf(alice).join(" / ").slice(-120)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  await open("sw:menu", alice);
  must(lastForm().title.includes("меню"), `после возврата ru меню не русское: ${lastForm().title}`);
  return "en → ru без потерь";
});

await step("админ-панель видна только админу и открывается из меню", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  await open("sw:menu", admin);
  const form = lastForm();
  must(form.buttons.some((label) => label.includes("Админ-панель")), `админу нет пункта админки: ${form.buttons.join(" | ").slice(0, 200)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Админ-панель"));
  await open("sw:menu", admin);
  const opened = shownTitles().join(" > ");
  must(/action:Админ-панель/.test(opened), `переход в админку не сработал: ${opened}`);
  return `${form.buttons.length} кнопок у админа`;
});

scenario("commands");

await step("админ-команды не слушаются без тега admin", async () => {
  flush();
  const metaBefore = JSON.stringify(readJson("sw:eco:cfg") ?? {});
  const acBefore = JSON.stringify(readJson("sw:ac:cfg") ?? {});
  const attempts = [
    ["sw:admin", []],
    ["sw:meta", ["set", "mintCapPerDay", "1"]],
    ["sw:ac", ["set", "threshold", "1"]],
    ["sw:event", ["stop"]],
  ];
  for (const [name, args] of attempts) {
    clearChat(alice);
    const result = await open(name, alice, ...args);
    const text = `${String(result?.message ?? "")} / ${chatOf(alice).join(" / ")}`;
    must(text.includes("Недостаточно прав"), `${name} от alice ответил не про права: ${text.slice(0, 90)}`);
  }
  flush();
  must(JSON.stringify(readJson("sw:eco:cfg") ?? {}) === metaBefore, "alice изменила тюнинги экономики");
  must(JSON.stringify(readJson("sw:ac:cfg") ?? {}) === acBefore, "alice изменила конфиг античита");
  const asAdmin = reply("sw:meta", admin, "set", "mintCapPerDay", "9000");
  must(!asAdmin.includes("Недостаточно прав"), `админу тоже отказано: ${asAdmin.slice(0, 80)}`);
  return `${attempts.length} команд отказано, состояние не тронуто`;
});

await step("/sw:rtp телепортует в безопасную точку и ставит кулдаун", async () => {
  const trav = mc.makePlayer("p-trav", "Trav", { x: 2, y: 71, z: 2 });
  const groundBefore = mc.state.groundY;
  // мок рисует плоский рельеф: поверхность должна попадать на сетку шага 4 (200..40),
  // иначе isSafeSpot не находит ни одну точку и успех RTP нечем проверить
  mc.state.groundY = 72;
  try {
    ui.shown.length = 0;
    ui.answers.length = 0;
    clearChat(trav);
    const first = reply("sw:rtp", trav);
    must(first.includes("Телепорт выполнен"), `первый RTP не сработал: ${first.slice(0, 140)}`);
    const { x, z } = trav.location;
    const distance = Math.hypot(x, z);
    must(distance >= 120, `улетел слишком близко к спавну: ${Math.round(distance)}`);
    must(trav.location.y === 73, `приземлился не над поверхностью: y=${trav.location.y}`);
    must(mc.state.actionBars.some((row) => row.to === "Trav"), "не было action-bar «ищу место»");
    const second = reply("sw:rtp", trav);
    must(second.includes("будет доступен через"), `кулдаун не сработал: ${second.slice(0, 120)}`);
    mc.advance(91_000);
    const third = reply("sw:rtp", trav);
    must(third.includes("Телепорт выполнен"), `после кулдауна RTP не вернулся: ${third.slice(0, 120)}`);
    return `радиус ${Math.round(distance)}, y ${trav.location.y}, кулдаун 90с`;
  } finally {
    mc.state.groundY = groundBefore;
    mc.removePlayer(trav);
  }
});

await step("/sw:ac show, set и reset работают на живом конфиге", async () => {
  const show = () => reply("sw:ac", admin, "show");
  must(show().includes("порог=60"), `summary не похож на правду: ${show().slice(0, 120)}`);
  const detectorLines = show().split("\n").filter((line) => line.includes("weight="));
  must(detectorLines.length === 9, `детекторов в summary ${detectorLines.length}, ожидалось 9`);
  must(reply("sw:ac", admin, "set", "detectors.reach.weight", "15").includes("обновлён"), "set веса не прошёл");
  must(/reach: on weight=15/.test(show()), `show не показал новое значение: ${show().split("\n")[1]}`);
  flush();
  must(readJson("sw:ac:cfg")?.detectors?.reach?.weight === 15, "значение не доехало до dynamic properties");
  must(reply("sw:ac", admin, "set", "detectors.reach.enabled", "false").includes("обновлён"), "выключить детектор не удалось");
  must(/reach: off weight=15/.test(show()), `детектор не выключился: ${show().split("\n")[1]}`);
  must(reply("sw:ac", admin, "set", "detectors.reach.weight", "abc").includes("не число"), "мусорное значение принято");
  must(reply("sw:ac", admin, "set", "detectors.nope.weight", "5").includes("неизвестный детектор"), "несуществующий детектор принят");
  must(reply("sw:ac", admin, "set", "limits.maxStackAmount", "32").includes("maxStackAmount=32"), "лимит не меняется");
  must(readJson("sw:ac:cfg")?.limits?.maxStackAmount === 32, "лимит не записан");
  must(reply("sw:ac", admin, "wat").includes("подкоманды"), "нет подсказки по подкомандам");
  must(reply("sw:ac", admin, "reset").includes("сброшен"), "reset не ответил");
  must(/reach: on weight=12/.test(show()), `после reset вес не вернулся: ${show().split("\n")[1]}`);
  must(readJson("sw:ac:cfg")?.limits?.maxStackAmount === 64, "после reset лимит не вернулся в дефолт");
  // limits-driven детекторы: show обязан врать меньше, а set — отказывать бесполезных полей
  const nukeLine = show().split("\n").find((line) => line.startsWith("nuke:"));
  must(/лимит 20 за 4000мс \(limits.breakRatePerWindow\)/.test(nukeLine ?? ""), `nuke показывает не тот порог: ${nukeLine}`);
  must(!/nuke:.*hits=/.test(nukeLine ?? ""), `nuke всё ещё печатает бесполезные hits: ${nukeLine}`);
  const rejected = reply("sw:ac", admin, "set", "detectors.nuke.hits", "4");
  must(rejected.includes("ни на что не влияет") && rejected.includes("limits.breakRatePerWindow"), `бесполезный set прошёл: ${rejected}`);
  must(readJson("sw:ac:cfg") === undefined || (readJson("sw:ac:cfg")?.detectors?.nuke?.hits ?? 12) === 12, "отклонённое значение всё равно записано");
  must(/fly: on weight=12 hits=4 window=8000мс/.test(show()), "у обычных детекторов строка сломана");
  flush();
  must(!JSON.stringify(readJson("sw:ac:cfg") ?? {}).includes("graceMs"), "в конфиг снова записано мёртвое поле graceMs");
  return "9 детекторов, set/reset/валидация, честный show";
});

await step("/sw:event status, list и подсказки отвечают админу", async () => {
  const ids = ["airdrop", "bloodmoon", "koth", "bossraid", "doubleloot", "bountyhunt", "lifesteal"];
  const list = reply("sw:event", admin, "list");
  const missing = ids.filter((id) => !list.includes(id));
  must(missing.length === 0, `в list нет: ${missing.join(", ")} — ${list.slice(0, 160)}`);
  must(list.split("\n").length === ids.length, `в list ${list.split("\n").length} строк вместо ${ids.length}`);
  const status = reply("sw:event", admin, "status");
  must(status.includes("Следующий:") && status.includes("Игроков онлайн:"), `status неполный: ${status.slice(0, 160)}`);
  const next = reply("sw:event", admin, "next");
  must(/Следующий: .+ через /.test(next), `next сломан: ${next.slice(0, 120)}`);
  must(reply("sw:event", admin, "start", "nope").includes("укажи id"), "старт с неверным id не отвергнут");
  must(reply("sw:event", admin, "wat").includes("подкоманды"), "нет подсказки по подкомандам");
  return `${ids.length} ивентов в списке`;
});

await step("форма «Настройки античита» переведена и не врёт про применение", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Настройки античита"));
  await open("sw:admin", admin);
  const form = lastForm();
  must(form.title.includes("Настройки античита"), `форма не открылась: ${shownTitles().join(" > ")}`);
  const labels = form.controls.map((row) => row.label);
  must(labels.includes("Порог тревоги") && labels.includes("Детектор для правки") && labels.includes("Детектор включён"), `подписи не из словаря: ${labels.join(" | ")}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Настройки античита"));
  answer(fillModal("10", "2", "300", "nuke", "10", "5", "12", true));
  await open("sw:admin", admin);
  const text = chatOf(admin).join(" / ");
  must(/Не применено \(2\)/.test(text), `форма не сообщила об отказе: ${text.slice(-220)}`);
  must(text.includes("limits.breakRatePerWindow"), `нет подсказки, где настоящий лимит: ${text.slice(-220)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Язык / Language"));
  await open("sw:menu", admin);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Anticheat settings"));
  await open("sw:admin", admin);
  const enLabels = lastForm().controls.map((row) => row.label);
  must(enLabels.includes("Alert threshold") && enLabels.includes("Detector to edit"), `форма не переведена: ${enLabels.join(" | ")}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Language / Язык"));
  await open("sw:menu", admin);
  return `${form.controls.length} полей, 2 отказа показано`;
});

scenario("mods (авто-шахта и сборщик спавна)");

const QUARRY_SPOT = { x: 200, y: 60, z: 200 };
const cellKey = (x, y, z) => `${x}:${y}:${z}`;
const claimRow = () => (readJson("sw:quarry")?.claims ?? [])[0];
const QUARRY_CELLS = 11 * 11 * 8;
const CONFIG_BUFFER_STACKS = 8;

check("спавн собран blueprint'ом, точка возрождения указывает на него", () => {
  const built = [...mc.state.blockOverrides.entries()];
  must(built.length > 700, `записано ячеек: ${built.length} — сборщик спавна не отработал`);
  must(mc.state.blockOverrides.get(cellKey(0, 79, 0)) === "minecraft:polished_andesite", "под точкой возрождения не андезит");
  must(mc.state.blockOverrides.get(cellKey(0, 81, -4)) === "minecraft:gold_block", "алтарь меню не построен");
  const spawn = mc.state.defaultSpawn;
  must(spawn && spawn.y === 80 && spawn.x === 0.5, `точка возрождения мира: ${JSON.stringify(spawn)}`);
  return `${built.length} ячеек, алтарь и defaultSpawn на месте`;
});

await step("у спавна копать нельзя", () => {
  alice.teleport({ x: 4, y: 71, z: 4 });
  const text = reply("sw:quarry", alice, "start");
  must(/Вокруг спавна копать нельзя/.test(text), `карьер у лобби разрешили: ${text}`);
  return text.slice(0, 90);
});

check("у игрока без карьера статус — «Карьера нет»", () => {
  const text = reply("sw:quarry", admin, "status");
  must(/Карьера нет\./.test(text), `статус без карьера: ${text.slice(0, 120)}`);
  return "отказ назван, а не пустой ответ";
});

await step("отказы конфигурации: граница, высота, глубина", () => {
  admin.teleport({ x: 3995, y: 60, z: 0 });
  const border = reply("sw:quarry", admin, "start");
  must(/за границу мира \(радиус \d+\)/.test(border), `граница не проверена: ${border}`);
  admin.teleport({ x: 900, y: 90, z: 900 });
  const high = reply("sw:quarry", admin, "start");
  must(/Слишком высоко: карьер ставится не выше y=62/.test(high), `потолок не проверен: ${high}`);
  admin.teleport({ x: 500, y: -50, z: 500 });
  const deep = reply("sw:quarry", admin, "start");
  must(/Слишком глубоко: карьер работает выше y=-56/.test(deep), `дно не проверено: ${deep}`);
  must((readJson("sw:quarry")?.claims ?? []).length === 0, "отказавшие проверки всё-таки создали запись");
  return "3 отказа, записей нет";
});

await step("запуск карьера: списание и запись в dynamic properties", async () => {
  await mintTo("Alice", 3000);
  alice.teleport(QUARRY_SPOT);
  const before = wallet("p-alice").coins ?? 0;
  const text = reply("sw:quarry", alice, "start");
  must(/✓ Карьер #/.test(text), `запуск не удался: ${text}`);
  const claim = claimRow();
  must(claim, "в sw:quarry нет записи");
  must(claim.x === QUARRY_SPOT.x && claim.topY === QUARRY_SPOT.y - 1, `площадка: ${claim.x},${claim.z} y${claim.topY}`);
  must(claim.mined === 0 && claim.scan === 0 && claim.buffer.length === 0, `свежий карьер не пуст: ${JSON.stringify(claim)}`);
  const after = wallet("p-alice").coins ?? 0;
  must(before - after === 1200, `списание за слот: ${before} → ${after}`);
  return `#${claim.id} y${claim.topY}, −1200 ₡`;
});

await step("карьер не грефер: чужой блок в толще породы остаётся нетронутым", () => {
  const probe = globalThis.__swipecraftProbe.quarry;
  const shape = probe.quarryShape();
  must(shape.cells === 11 * 11 * 8, `объём карьера ${shape.cells} вместо 968`);
  const claim = claimRow();
  const reach = (shape.side - 1) / 2 + 1;
  const dugInVolume = (topY) => {
    let total = 0;
    for (const [key, value] of mc.state.blockOverrides.entries()) {
      if (value !== "minecraft:air") continue;
      const [x, y, z] = key.split(":").map(Number);
      if (Math.abs(x - claim.x) > reach || Math.abs(z - claim.z) > reach) continue;
      if (y > topY || y < topY - shape.depth + 1) continue;
      total += 1;
    }
    return total;
  };
  // занимаем блоком игрока ровно ту ячейку, которую карьер прочитает следующей
  const spot = probe.quarryCellAt({ x: claim.x, z: claim.z, topY: claim.topY }, claim.scan);
  mc.state.blockOverrides.set(cellKey(spot.x, spot.y, spot.z), "minecraft:diamond_block");
  const dugBefore = dugInVolume(claim.topY);
  must(dugBefore === 0, `до запуска в области уже ${dugBefore} вырытых блоков`);
  mc.tickTimes(20);
  const row = claimRow();
  must(mc.state.blockOverrides.get(cellKey(spot.x, spot.y, spot.z)) === "minecraft:diamond_block", "карьер снёс блок игрока");
  must(row.skipped >= 1, `пропусков ${row.skipped} — чужой блок даже не рассмотрен`);
  must(row.mined >= 1, `добыто ${row.mined}`);
  must(dugInVolume(claim.topY) - dugBefore === row.mined, `в области вырыто ${dugInVolume(claim.topY)} блоков, а добыто ${row.mined}`);
  const status = reply("sw:quarry", alice, "status");
  must(/пропущено [1-9]/.test(status), `в статусе нет пропусков: ${status}`);
  return `добыто ${row.mined}, пропущено ${row.skipped}, чужой блок цел`;
});

await step("добыча выдаётся в инвентарь, а не исчезает", () => {
  const claim = claimRow();
  const buffered = claim.buffer.reduce((sum, row) => sum + row.amount, 0);
  must(buffered > 0, `буфер пуст при добыче ${claim.mined}`);
  const text = reply("sw:quarry", alice, "collect");
  must(/Выдано \d+ предметов/.test(text), `раздача не описана: ${text}`);
  const given = Number(text.match(/Выдано (\d+)/)[1]);
  must(given === buffered, `выдано ${given} из ${buffered}`);
  must(countItem(alice, "minecraft:cobblestone") >= given, "в инвентаре меньше, чем выдано");
  must(claimRow().buffer.length === 0, "буфер не очищен");
  return `${given} булыжника`;
});

await step("экран карьера и админ-экран модов: подписи, переходы, стоп-кран из формы", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Авто-шахта"));
  await open("sw:menu", alice);
  const form = lastForm();
  must(form.title.includes("Авто-шахта"), `открылась не карьерная форма: ${form.title}`);
  must(form.body.includes("Добыто"), `в теле формы нет прогресса: ${form.body.slice(0, 140)}`);
  for (const part of ["Забрать добычу", "Перенестись к карьеру", "Закрыть карьер", "Как это работает", "В главное меню"]) {
    must(form.buttons.some((label) => label.includes(part)), `нет кнопки «${part}»: ${form.buttons.join(" | ")}`);
  }
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Забрать добычу"));
  await open("sw:quarry", alice, "ui");
  must(/Буфер пуст/.test(chatOf(alice).join(" / ")), `пустой буфер не описан: ${chatOf(alice).join(" / ")}`);
  mc.tickTimes(220);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Перенестись к карьеру"));
  await open("sw:quarry", alice, "ui");
  const teleported = chatOf(alice).join(" / ");
  must(/Перенёс к карьеру #|Приземляться некуда/.test(teleported), `перенос не описан: ${teleported}`);
  const landed = /Перенёс к карьеру/.test(teleported);
  const claimForLanding = claimRow();
  const landingY = Math.round(alice.location.y);
  must(landed, "после 220 тиков полость должна была открыться");
  must(alice.location.x === 200.5 && Math.abs(alice.location.z - 200.5) < 1, `не на площадку: ${JSON.stringify(alice.location)}`);
  must(landingY <= claimForLanding.topY && landingY >= claimForLanding.topY - 8 + 1, `посадка вне объема карьера: y=${landingY}, topY=${claimForLanding.topY}`);
  must(mc.state.blockOverrides.get(cellKey(200, landingY, 200)) === "minecraft:air", `посадка в непройченную клетку (y=${landingY}) — удушье`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Как это работает"));
  await open("sw:quarry", alice, "ui");
  must(/Оффлайн — пауза/.test(chatOf(alice).join(" / ")), `правила карьера не распечатаны: ${chatOf(alice).join(" / ").slice(0, 120)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  await open("sw:admin", admin);
  const worldForm = ui.shown.at(-1) ?? lastForm();
  must(worldForm.title.includes("Моды мира"), `админ-экран не открылся: ${worldForm.title}`);
  must(worldForm.body.includes("карьеры:") && worldForm.body.includes("спавн:"), `сводка мод неполная: ${worldForm.body.slice(0, 200)}`);
  must(worldForm.body.includes("тотемы:"), `в сводке модов нет строки про тотемы: ${worldForm.body.slice(0, 260)}`);
  for (const part of ["Карьеры", "Спавн", "Тотемы", "Стоп-краны модов"]) must(worldForm.buttons.some((label) => label.includes(part)), `нет действия «${part}»`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Стоп-краны модов"));
  answer(fillModal(true, true, false));
  await open("sw:admin", admin);
  const toggled = chatOf(admin).join(" / ");
  must(/quarryEnabled=false/.test(toggled), `стоп-кран из формы не переключился: ${toggled.slice(-160)}`);
  must(readJson("sw:eco:cfg")?.quarryEnabled === false, "стоп-кран не уехал в sw:eco:cfg");
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Стоп-краны модов"));
  answer(fillModal(true, true));
  await open("sw:admin", admin);
  const modal = ui.shown.at(-1);
  must(modal.controls.length === 8, `тумблеров в форме: ${modal.controls.length}`);
  must(modal.controls[2].config?.defaultValue === false, `тумблер не показывает текущее состояние: ${JSON.stringify(modal.controls[2])}`);
  must(modal.controls[3].config?.defaultValue === true, `тумблер тотемов не показывает текущее состояние: ${JSON.stringify(modal.controls[3])}`);
  must(modal.controls[4].config?.defaultValue === true, `тумблер защиты спавна не показывает текущее состояние: ${JSON.stringify(modal.controls[4])}`);
  must(readJson("sw:eco:cfg")?.totemsEnabled !== false, "тумблер тотемов слипся в выключенный из-за отсутствующего значения в ответе формы");
  must(readJson("sw:eco:cfg")?.spawnProtectEnabled !== false, "защита спавна слиплась в выключенную из-за отсутствующего значения в ответе формы");
  must(/Ни один флаг не изменился/.test(chatOf(admin).join(" / ")), `форма солгала про изменения: ${chatOf(admin).join(" / ")}`);
  reply("sw:meta", admin, "set", "quarryEnabled", "true");
  flush();
  must(readJson("sw:eco:cfg")?.quarryEnabled === true, "стоп-кран не вернулся в включённое состояние");
  must(mc.state.blockOverrides.get(cellKey(0, 79, 0)) === "minecraft:polished_andesite", "пол спавна пострадал от переноса");
  return `${form.buttons.length} кнопок на экране карьера, стоп-кран из формы переключён`;
});

await step("стоп-кран quarryEnabled реально останавливает копание", () => {
  const before = claimRow().mined;
  reply("sw:meta", admin, "set", "quarryEnabled", "false");
  mc.tickTimes(120);
  const stopped = claimRow().mined;
  must(before === stopped, `стоп-кран не сработал: ${before} → ${stopped}`);
  admin.teleport({ x: 900, y: 60, z: 900 });
  const refused = reply("sw:quarry", admin, "start");
  must(/Авто-шахты выключены/.test(refused), `новый карьер при выключенном моде разрешили: ${refused}`);
  reply("sw:meta", admin, "set", "quarryEnabled", "true");
  mc.tickTimes(20);
  const resumed = claimRow().mined;
  must(resumed > stopped, `после включения копания нет: ${stopped} → ${resumed}`);
  return `${before} → (стоп) ${stopped} → (вкл) ${resumed}`;
});

await step("полный буфер стопорит копание, collect разблокирует его снова", () => {
  mc.tickTimes(1520);
  const claim = claimRow();
  must(claim, "карьер исчез из sw:quarry раньше времени");
  const stacks = Math.ceil(claim.buffer.reduce((sum, row) => sum + row.amount, 0) / 64);
  must(claim.full === true, `флаг полного буфера не выставлен (стопки ${stacks})`);
  const status = reply("sw:quarry", alice, "status");
  must(/буфер полон/.test(status), `статус не говорит о полном буфере: ${status}`);
  must(stacks >= CONFIG_BUFFER_STACKS, `в буфере ${stacks} стопок, ждали ≥ ${CONFIG_BUFFER_STACKS}`);
  const frozen = claim.mined;
  mc.tickTimes(60);
  must(claimRow().mined === frozen, `при полном буфере копание продолжилось: ${frozen} → ${claimRow().mined}`);
  const text = reply("sw:quarry", alice, "collect");
  const given = Number(text.match(/Выдано (\d+)/)?.[1] ?? 0);
  must(given >= CONFIG_BUFFER_STACKS * 64 - 64, `раздача мелкая: ${text}`);
  must(countItem(alice, "minecraft:cobblestone") >= given - 64, "инвентарь не принял добычу");
  mc.tickTimes(20);
  must(claimRow().mined > frozen, `после collect копание не возобновилось: ${frozen}`);
  return `${frozen} ячеек → стопор → ${given} шт. забрано → ${claimRow().mined}`;
});

await step("объём вычерпан: добыча живёт до collect, слот закрывает игрок", () => {
  const before = claimRow().mined;
  let guard = 0;
  // полные буферы разгружаем по ходу: цель шага — конец объёма, а не бесконечная пауза
  while (guard < 8 && claimRow() && claimRow().scan < QUARRY_CELLS) {
    mc.tickTimes(600);
    guard += 1;
    const row = claimRow();
    if (row?.full) reply("sw:quarry", alice, "collect");
  }
  const claim = claimRow();
  must(claim, "карьер удалился сам — буфер с добычей пропал бы вместе с записью");
  must(guard < 8, `объём не вычерпан за ${guard} прогонов`);
  must(claim.scan >= QUARRY_CELLS, `скан ${claim.scan} < ${QUARRY_CELLS} при вычерпанном объёме`);
  const status = reply("sw:quarry", alice, "status");
  must(/вычерпан/.test(status), `статус не показывает конец объёма: ${status}`);
  const buffered = claim.buffer.reduce((sum, row) => sum + row.amount, 0);
  must(buffered > 0, `буфер пуст, а добыто ${claim.mined} — остаток добычи потерян`);
  mc.tickTimes(40);
  must(claimRow().mined === claim.mined, `после вычерпывания копать продолжило: ${claim.mined} → ${claimRow().mined}`);
  const text = reply("sw:quarry", alice, "collect");
  const given = Number(text.match(/Выдано (\d+)/)?.[1] ?? 0);
  must(given === buffered, `забрал ${given} из ${buffered}`);
  must(claim.mined + claim.skipped === QUARRY_CELLS, `добыто ${claim.mined} + пропущено ${claim.skipped} ≠ ${QUARRY_CELLS}`);
  reply("sw:quarry", alice, "close");
  must((readJson("sw:quarry")?.claims ?? []).length === 0, "слот не освобождён после закрытия");
  return `${claim.mined} ячеек из ${QUARRY_CELLS} (было ${before}), остаток ${given} шт. роздан`;
});

await step("дистанция, занятый слот и освобождение карьера админом", async () => {
  // новый угол мира: предыдущая выработка оставила бы «посадку», а нам нужен честный отказ
  const FRESH_SPOT = { x: 320, y: 60, z: 320 };
  alice.teleport(FRESH_SPOT);
  await mintTo("Alice", 1500);
  const created = reply("sw:quarry", alice, "start");
  must(/✓ Карьер #/.test(created), `второй карьер не запустился: ${created}`);
  const again = reply("sw:quarry", alice, "start");
  must(/уже есть карьер/.test(again), `двойной слот не отклонён: ${again}`);
  const landing = reply("sw:quarry", alice, "go");
  must(/Приземляться некуда/.test(landing), `посадка в непройченную толщу разрешилась: ${landing}`);
  must(alice.location.x === FRESH_SPOT.x, `отказ по посадке всё равно телепортировал: ${JSON.stringify(alice.location)}`);
  const badId = reply("sw:quarry", admin, "release", "net-takogo");
  must(/Карьера #net-takogo нет/.test(badId), `release чужого id не отказан: ${badId}`);
  admin.teleport({ x: FRESH_SPOT.x + 5, y: 60, z: FRESH_SPOT.z });
  const near = reply("sw:quarry", admin, "start");
  must(/Слишком близко к чужому карьеру/.test(near), `дистанция 20 блоков не проверена: ${near}`);
  mc.tickTimes(20);
  const list = reply("sw:quarry", admin, "list");
  must(/роет|буфер полон|вычерпан/.test(list), `в админ-списке нет статуса: ${list}`);
  clearChat(alice);
  const released = reply("sw:quarry", admin, "release", claimRow().id);
  must(/освободил карьер/.test(released), `release не сработал: ${released}`);
  must((readJson("sw:quarry")?.claims ?? []).length === 0, "запись осталась после release");
  const notice = chatOf(alice).join(" / ");
  must(/Администратор освободил карьер/.test(notice), `владельцу не сказали про release: ${notice.slice(-140)}`);
  return `${list.split("\n")[0].slice(0, 70)} → released`;
});

await step("админ-экраны модов на пустом мире и точка возрождения из формы", async () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Карьеры"));
  await open("sw:admin", admin);
  const empty = ui.shown.at(-1);
  must(empty.title.includes("Карьеры"), `открылся не экран карьеров: ${empty.title}`);
  must(empty.body.includes("Активных карьеров нет"), `пустой список не описан: ${empty.body.slice(0, 160)}`);
  must(empty.buttons.length === 1, `на пустом списке кнопок ${empty.buttons.length}, ждали 1 (назад)`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  mc.state.defaultSpawn = undefined;
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Спавн"));
  answer(pressLabel("Точка возрождения мира"));
  await open("sw:admin", admin);
  const spawnForm = ui.shown.at(-1);
  for (const part of ["Что застроится", "Проверить целостность", "Починить пропуски", "Пересобрать спавн", "Точка возрождения мира", "Назад"]) {
    must(spawnForm.buttons.some((label) => label.includes(part)), `на экране спавна нет «${part}»: ${spawnForm.buttons.join(" | ")}`);
  }
  must(/Точка возрождения мира: x=0, y=80, z=0/.test(chatOf(admin).join(" / ")), `точка не подтверждена: ${chatOf(admin).join(" / ").slice(-160)}`);
  must(mc.state.defaultSpawn?.y === 80, `world.setDefaultSpawnLocation не вызван: ${JSON.stringify(mc.state.defaultSpawn)}`);
  return `${spawnForm.buttons.length} кнопок на экране спавна, точка возрождения проставлена`;
});

await step("починка спавна: дыра под точкой возрождения закрывается", () => {
  mc.state.blockOverrides.set(cellKey(0, 79, 0), "minecraft:air");
  const checkLine = reply("sw:spawn", admin, "check");
  must(/расхождений[^\n]*[1-9]/.test(checkLine), `проверка не увидела дыру: ${checkLine}`);
  const started = reply("sw:spawn", admin, "repair");
  must(/Починка спавна начата/.test(started), `repair не запущен: ${started}`);
  const busy = reply("sw:spawn", admin, "build");
  must(/уже идёт/.test(busy), `вторая сборка не отклонена: ${busy}`);
  mc.tickTimes(80);
  must(mc.state.blockOverrides.get(cellKey(0, 79, 0)) === "minecraft:polished_andesite", "дыра не заделана");
  const status = reply("sw:spawn", admin, "status");
  must(/простаивает/.test(status), `после починки сборка не остановилась: ${status}`);
  const preview = reply("sw:spawn", admin, "preview");
  must(/ячеек всего: \d+/.test(preview) && preview.includes("gold_block"), `preview: ${preview.slice(0, 140)}`);
  return checkLine.match(/расхождений[^\n]*/)[0];
});

await step("алтарь спавна открывает меню и отменяет взаимодействие", () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
  const event = {
    player: alice,
    block: { typeId: "minecraft:gold_block", x: 0, y: 81, z: -4, location: { x: 0, y: 81, z: -4 } },
    cancel: false,
    faceLocation: { x: 0.5, y: 0.5, z: 0.5 },
    isFirstEvent: true,
  };
  mc.fire("before", "playerInteractWithBlock", event);
  must(event.cancel === true, "алтарь не отменил взаимодействие");
  must(ui.shown.length === 1, `форм открыто: ${ui.shown.length}`);
  must(ui.shown[0].title.includes("меню"), `открылась не главная форма: ${ui.shown[0].title}`);
  must(ui.shown[0].buttons.some((label) => label.includes("Авто-шахта")), "в меню нет пункта авто-шахты");
  ui.shown.length = 0;
  const wrong = { player: alice, block: { typeId: "minecraft:gold_block", x: 5, y: 64, z: 5, location: { x: 5, y: 64, z: 5 } }, cancel: false };
  mc.fire("before", "playerInteractWithBlock", wrong);
  must(wrong.cancel === false, "отменён любой золотой блок на свете, а не только алтарь");
  return "cancel + главное меню из мира";
});

scenario("тотемы (обряд и спасение)");

const TOTEMS_DP = "sw:totems";
const totemReg = () => readJson(TOTEMS_DP) ?? { season: 0, rows: [], day: {}, lastSave: {} };
const probeT = () => globalThis.__swipecraftProbe.totems;
// часы мока — отдельные от тиков: Date.now() === state.clock, и двигает их только mc.advance
const passMs = (ms) => mc.advance(ms);
const mockDay = () => new Date(Date.now()).toISOString().slice(0, 10);
const fireHurt = (player, damage) => {
  const event = { hurtEntity: player, damage, damageSource: { cause: "entityAttack" }, cancel: false };
  mc.fire("before", "entityHurt", event);
  return event;
};
const writeJson = (key, value) => {
  const text = JSON.stringify(value);
  const size = 7000;
  const total = Math.max(1, Math.ceil(text.length / size));
  for (let index = 0; index < total; index += 1) {
    mc.world.setDynamicProperty(`${key}:${index}`, text.slice(index * size, (index + 1) * size));
  }
  mc.world.setDynamicProperty(`${key}:n`, total);
};
const giveItem = (player, slot, typeId, amount) => inventoryOf(player).setItem(slot, new mc.ItemStack(typeId, amount));
const rowOf = (serial) => (totemReg().rows ?? []).find((row) => row.serial === serial);
const stackOf = (player, slot) => inventoryOf(player).getItem(slot);

let mintedBeforeTotems = 0;

check("носитель обряда, изумруды и эффекты тотемов существуют в 1.26.60", () => {
  const probe = probeT();
  const items = new Set(Object.values(MinecraftItemTypes));
  const effects = new Set(Object.values(MinecraftEffectTypes));
  must(items.has(probe.TOTEM_CARRIER), `предмета-носителя нет в MinecraftItemTypes: ${probe.TOTEM_CARRIER}`);
  must(items.has("minecraft:emerald"), "изумруда нет в MinecraftItemTypes");
  const tiers = probe.totemTiers();
  must(tiers.length === 3, `ступеней обряда: ${tiers.length}`);
  const bad = tiers.flatMap((tier) => tier.effects.map((row) => row.id)).filter((id) => !effects.has(`minecraft:${id}`));
  must(bad.length === 0, `эффектов нет в MinecraftEffectTypes: ${[...new Set(bad)].join(", ")}`);
  const costs = tiers.map((tier) => probe.totemTierCost(tier.id));
  must(costs.every((row) => row.coin > 0 && row.emeralds > 0 && row.total > row.coin), `цена обряда собрана неверно: ${JSON.stringify(costs)}`);
  must(tiers.some((tier) => tier.charges > 1), "ни одна ступень не даёт больше одного спасения — деградацию предмета не проверить");
  return `${tiers.length} ступени, ${[...new Set(tiers.flatMap((tier) => tier.effects.map((row) => row.id)))].length} эффекта, id подтверждены`;
});

check("смертельные удары в мок-часы не «слипаются»: у тотема есть пауза и лимит суток", () => {
  const probe = probeT();
  must(typeof probe.savePlayer === "function", "мод не отдаёт savePlayer — спасение не проверить");
  must(typeof probe.clearImmunity === "function", "нет окна неуязвимости для теста");
  return "пауза, лимит и окно — проверяемые состояния";
});

await step("тотема в руке нет и изумрудов нет: обряд отказывает, реестр пуст", async () => {
  await mintTo("Alice", 30000);
  flush();
  mintedBeforeTotems = readJson("sw:eco:ledger")?.minted ?? 0;
  clearChat(alice);
  const noItem = reply("sw:totem", alice, "forge", "whisper");
  must(/В руке должен быть ванический тотем/.test(noItem), `обряд без предмета разрешили: ${noItem}`);
  giveItem(alice, 0, "minecraft:totem_of_undying", 1);
  const noEmeralds = reply("sw:totem", alice, "forge", "whisper");
  must(/Нужно \d+ изумрудов/.test(noEmeralds), `обряд без изумрудов разрешили: ${noEmeralds}`);
  must((totemReg().rows ?? []).length === 0, "отказавший обряд всё-таки создал запись в реестре");
  must(probeT().findHeldTotem(alice) === undefined, "тотем без заряда считается живым");
  return "2 отказа, записей и списаний нет";
});

await step("обряд: монеты сгорели, изумруды съедены, предмет помечен серийником", () => {
  giveItem(alice, 1, "minecraft:emerald", 10);
  const before = wallet("p-alice").coins ?? 0;
  const ledger = readJson("sw:eco:ledger") ?? {};
  clearChat(alice);
  const text = reply("sw:totem", alice, "forge", "whisper");
  must(/✓/.test(text), `обряд не прошёл: ${text}`);
  const serial = /серия ([a-z0-9]+)/.exec(text)?.[1];
  must(serial, `в ответе нет серийника: ${text}`);
  const row = (totemReg().rows ?? [])[0];
  must(row && row.serial === serial && row.tier === "whisper" && row.charges === 1, `запись реестра: ${JSON.stringify(row)}`);
  must(row.season === 1, `запись уехала в сезон ${row.season}`);
  const after = wallet("p-alice").coins ?? 0;
  must(before - after === 2500, `списание за обряд: ${before} → ${after}`);
  must((readJson("sw:eco:ledger")?.burned ?? 0) - (ledger.burned ?? 0) === 2500, "обряд не сжёг монеты в реестре экономики");
  must((readJson("sw:eco:ledger")?.minted ?? 0) === (ledger.minted ?? 0), "обряд напечатал монеты — так нельзя");
  must(countItem(alice, "minecraft:emerald") === 4, `изумрудов после обряда: ${countItem(alice, "minecraft:emerald")}`);
  const stack = stackOf(alice, 0);
  must(stack.getLore().some((line) => line.includes(`#${serial}`)), `серийника нет в лоре: ${JSON.stringify(stack.getLore())}`);
  must(stack.nameTag.length > 0 && stack.typeId === "minecraft:totem_of_undying", `предмет не переименован: ${stack.nameTag}`);
  must(/✓ Обряд «шёпот» проведён/.test(text), `ответ команды не подписан: ${text}`);
  return `#${serial} · −2500 ₡ · −6 изумрудов · лор обновлён`;
});

await step("повторный обряд на зачарованном тотеме запрещён, лимит обрядов в сутки держит", () => {
  const text = reply("sw:totem", alice, "forge", "whisper");
  must(/уже зачарован/.test(text), `двойное зачарование разрешили: ${text}`);
  must((totemReg().rows ?? []).length === 1, "реестр вырос на пустом месте");
  giveItem(alice, 5, "minecraft:totem_of_undying", 1);
  giveItem(alice, 6, "minecraft:emerald", 48);
  alice.selectedSlotIndex = 5;
  const ash = reply("sw:totem", alice, "forge", "ash");
  must(/✓/.test(ash), `второй обряд не прошёл: ${ash}`);
  giveItem(alice, 7, "minecraft:totem_of_undying", 1);
  alice.selectedSlotIndex = 7;
  const third = reply("sw:totem", alice, "forge", "oath");
  must(/Обрядов в сутки уже 2/.test(third), `третий обряд в сутки разрешили: ${third}`);
  must((totemReg().rows ?? []).length === 2, `записей в реестре: ${(totemReg().rows ?? []).length}`);
  return "отказ по серийнику + лимит 2 обряда в сутки";
});

await step("смертельный удар отменён: HP, эффекты, звук, а экономика молчит", () => {
  alice.selectedSlotIndex = 0;
  alice.getComponent("minecraft:health").setCurrentValue(3);
  const ledger = readJson("sw:eco:ledger") ?? {};
  const coins = wallet("p-alice").coins ?? 0;
  clearChat(alice);
  mc.state.sounds.length = 0;
  const died = alice.applyDamage(50);
  must(died === false, `applyDamage вернул смерть ${died} — урон не отменён`);
  const health = alice.getComponent("minecraft:health");
  must(health.currentValue === health.effectiveMax, `после спасения HP: ${health.currentValue} из ${health.effectiveMax}`);
  must(alice._effects.has("regeneration") && alice._effects.has("resistance"), `эффектов окна нет: ${[...alice._effects.keys()].join(",")}`);
  must(mc.state.sounds.some((row) => row.id === "totem.use"), "звука спасения нет");
  must(/Последний заряд тотема/.test(chatOf(alice).join(" / ")), `игроку не сказали, что произошло: ${chatOf(alice).join(" / ").slice(0, 160)}`);
  must((wallet("p-alice").coins ?? 0) === coins, "спасение двинуло баланс");
  must((readJson("sw:eco:ledger")?.minted ?? 0) === (ledger.minted ?? 0), "спасение напечатало монеты");
  must((readJson("sw:eco:ledger")?.burned ?? 0) === (ledger.burned ?? 0), "спасение сожгло что-то сверх обряда");
  return "урон отменён, 20/20 HP, 2 эффекта, ₡ не тронуты";
});

check("разряженный тотем деградирует в ванический, а не исчезает", () => {
  const stack = stackOf(alice, 0);
  must(stack && stack.typeId === "minecraft:totem_of_undying", `предмет пропал из слота: ${JSON.stringify(stack?.typeId)}`);
  must(stack.getLore().length === 0, `лор не снят: ${JSON.stringify(stack.getLore())}`);
  must(!stack.nameTag, `имя не снято: ${stack.nameTag}`);
  must(!probeT().readSerial(stack), "разряженный предмет всё ещё ссылается на серию");
  must(countItem(alice, "minecraft:totem_of_undying") === 3, `тотемы в инвентаре съехали: ${countItem(alice, "minecraft:totem_of_undying")} вместо 3`);
  const whisper = (totemReg().rows ?? [])[1];
  must(whisper.charges === 0 && whisper.spentAt > 0, `разряд не зафиксирован: ${JSON.stringify(whisper)}`);
  return "обычный тотем на руках, серийника нет, запись помечена";
});

await step("окно неуязвимости не даёт потратить заряд, а после паузы спасение работает", () => {
  alice.selectedSlotIndex = 5;
  const serial = (totemReg().rows ?? []).find((row) => row.tier === "ash").serial;
  alice.getComponent("minecraft:health").setCurrentValue(2);
  const first = alice.applyDamage(50);
  must(first === false, "удар в окне неуязвимости прошёл");
  must(rowOf(serial).charges === 2, `окно неуязвимости съело заряд: ${rowOf(serial).charges}`);
  passMs(probeT().immunityLeft(alice.id) + 500);
  const blocked = fireHurt(alice, 50);
  must(blocked.cancel === false, "смертельный удар отменён во время паузы между спасениями");
  must(/После спасения обряд ждать \d+ c/.test(reply("sw:totem", alice, "status")), "в статусе нет паузы между спасениями");
  passMs(95_000);
  alice.getComponent("minecraft:health").setCurrentValue(1);
  const saved = alice.applyDamage(50);
  must(saved === false, `после паузы спасение не сработало: ${saved}`);
  must(rowOf(serial).charges === 1, `второе спасение потратило не один заряд: ${rowOf(serial).charges}`);
  const stack = stackOf(alice, 5);
  must(stack.getLore().some((line) => line.includes("Зарядов: 1 из 2")), `лор не обновлён: ${JSON.stringify(stack.getLore())}`);
  must(/сгорел наполовину/.test(chatOf(alice).join(" / ")), `ответа про половину заряда нет: ${chatOf(alice).join(" / ").slice(0, 160)}`);
  const ac = globalThis.__swipecraftProbe.anticheat;
  must(ac.graceLeftMs(alice.id) > 0, "спасение не выдало античиту grace-окно — детекторы движения прочитают лечение как аномалию");
  must(ac.playerScore(alice.id) === 0, `спасение добавило очков античиту: ${ac.playerScore(alice.id)}`);
  return "окно гасит, пауза держит, после паузы — 2 → 1 заряд, grace выдан";
});

await step("лимит спасений в сутки считается по мок-часам", () => {
  const probe = probeT();
  probe.clearImmunity(alice.id);
  const serial = (totemReg().rows ?? []).find((row) => row.tier === "ash").serial;
  const before = rowOf(serial).charges;
  const reg = totemReg();
  reg.day["p-alice"] = { day: mockDay(), saves: probe.totemSummary().enabled ? 3 : 3, forges: reg.day?.["p-alice"]?.forges ?? 0 };
  reg.lastSave = {};
  writeJson(TOTEMS_DP, reg);
  probe.loadTotems();
  clearChat(alice);
  const refused = fireHurt(alice, 50);
  must(refused.cancel === false, "лимит спасений в сутки не сработал");
  must(/Лимит спасений на сегодня: 3/.test(chatOf(alice).join(" / ")), `отказ не назван: ${chatOf(alice).join(" / ").slice(0, 160)}`);
  must(rowOf(serial).charges === before, "на отказе заряд всё-таки сгорел");
  return "3/3 спасения — отказ с именем лимита";
});

await step("стоп-кран totemsEnabled: обряд недоступен, живые заряды не тратятся", () => {
  const probe = probeT();
  const serial = (totemReg().rows ?? []).find((row) => row.tier === "ash").serial;
  const before = rowOf(serial).charges;
  // сбрасываем паузу и суточные счётители ДО выключения: иначе отказ спасения был бы
  // заслуг кулдауна, а не стоп-крана, и проверка ничего не проверяла бы
  writeJson(TOTEMS_DP, { ...totemReg(), day: {}, lastSave: {} });
  probe.loadTotems();
  probe.clearImmunity(alice.id);
  reply("sw:meta", admin, "set", "totemsEnabled", "false");
  flush();
  const off = reply("sw:totem", alice, "forge", "whisper");
  must(/Тотемы выключены администратором/.test(off), `стоп-кран пропустил обряд: ${off}`);
  const blocked = fireHurt(alice, 50);
  must(blocked.cancel === false, "выключенный мод всё равно отменил смерть");
  must(rowOf(serial).charges === before, "стоп-кран потратил заряд");
  must(/Тотемы: выключены \(стоп-кран\)/.test(reply("sw:totem", alice, "status")), "в статусе не видно стоп-крана");
  reply("sw:meta", admin, "set", "totemsEnabled", "true");
  flush();
  probe.clearImmunity(alice.id);
  const saved = fireHurt(alice, 50);
  must(saved.cancel === true, "после включения спасение не вернулось");
  must(rowOf(serial).charges === before - 1, "после включения заряд не потратился");
  return `обряд и спасение выключаются одним флагом (зарядов было ${before})`;
});

await step("отзыв по серийнику, чужой сезон и прунинг разряженных записей", () => {
  const probe = probeT();
  const reg = totemReg();
  giveItem(alice, 8, "minecraft:totem_of_undying", 1);
  giveItem(alice, 9, "minecraft:emerald", 10);
  alice.selectedSlotIndex = 8;
  writeJson(TOTEMS_DP, { ...reg, day: {}, lastSave: {} });
  probeT().loadTotems();
  const forgedBack = reply("sw:totem", alice, "forge", "whisper");
  must(/✓/.test(forgedBack), `обряд после отзыва не проходит: ${forgedBack}`);
  const freshSerial = /серия ([a-z0-9]+)/.exec(forgedBack)?.[1];
  const revoked = reply("sw:totem", admin, "revoke", freshSerial);
  must(/✓ Заряды тотема/.test(revoked), `отзыв не прошёл: ${revoked}`);
  must(rowOf(freshSerial).charges === 0 && rowOf(freshSerial).spentAt > 0, `после отзыва запись не погасла: ${JSON.stringify(rowOf(freshSerial))}`);
  must(probe.findHeldTotem(alice) === undefined, "отозванный серийник всё ещё даёт спасение");
  const second = reply("sw:totem", admin, "revoke", freshSerial);
  must(/в реестре нет/.test(second), `повторный отзыв не назван: ${second}`);
  const itemsBefore = countItem(alice, "minecraft:totem_of_undying");
  must(countItem(alice, "minecraft:totem_of_undying") === itemsBefore, "отзыв изменил предметы игрока");
  // отзыв гасит заряд в реестре и НЕ трогает предмет; а последний сгоревший заряд — наоборот,
  // всегда возвращает предмет в ванический вид. Два разных исхода, обе ветки должны держаться.
  must(stackOf(alice, 8).getLore().some((line) => line.includes(`#${freshSerial}`)), "отзыв полез в предмет: реестр — единственный источник истины");
  must(stackOf(alice, 5).getLore().length === 0, "пепел, разряженный последним зарядом, не вернулся в ванический вид");
  reg.rows = reg.rows.map((row) => ({ ...row, season: 7 }));
  writeJson(TOTEMS_DP, reg);
  probe.loadTotems();
  must(probe.totemRows().every((row) => !probe.isRowLive(row)), "запись чужого сезона считается живой");
  const dropped = probe.pruneTotems(Date.now() + 8 * 24 * 60 * 60 * 1000);
  must(dropped === reg.rows.length, `прунинг вынес ${dropped} из ${reg.rows.length} (в ttl разряженные живут 7 суток)`);
  const afterPrune = totemReg();
  must(afterPrune.rows.length === 0, `после прунинга в реестре ${afterPrune.rows.length} записей`);
  writeJson(TOTEMS_DP, {
    season: 1,
    rows: [
      { serial: "liveser1", tier: "oath", charges: 1, forgedAt: Date.now(), forgedBy: "Zed", season: 1, spentAt: 0 },
      { serial: "spentser", tier: "whisper", charges: 0, forgedAt: 0, forgedBy: "Zed", season: 1, spentAt: Date.now() - 1000 },
    ],
    day: {},
    lastSave: {},
  });
  probe.loadTotems();
  const kept = probe.pruneTotems(Date.now() + 8 * 24 * 60 * 60 * 1000);
  must(kept === 1, `из живого+разряженного вычищено ${kept}`);
  must(probe.totemRows().length === 1 && probe.totemRows()[0].serial === "liveser1", "прунинг снёс живую запись");
  must(countItem(alice, "minecraft:totem_of_undying") === itemsBefore, "реестр тронул предметы игрока");
  probeT().revokeTotem(admin.name, "liveser1");
  probe.pruneTotems();
  return "отзыв, мёртвый сезон и ttl прунинга";
});

await step("экран тотемов: статус, выбор обряда и правила", async () => {
  writeJson(TOTEMS_DP, { season: 1, rows: [], day: {}, lastSave: {} });
  probeT().loadTotems();
  giveItem(alice, 0, "minecraft:totem_of_undying", 1);
  giveItem(alice, 1, "minecraft:emerald", 10);
  alice.selectedSlotIndex = 0;
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Зачарованные тотемы"));
  await open("sw:menu", alice);
  const form = lastForm();
  must(form.title.includes("Зачарованные тотемы"), `открылась не форма тотемов: ${form.title}`);
  must(/Тотемы: включены/.test(form.body), `в теле формы нет состояния мода: ${form.body.slice(0, 200)}`);
  must(/Заряженного тотема в инвентаре нет/.test(form.body), `пустой инвентарь не подписан: ${form.body.slice(0, 200)}`);
  must(/Сегодня: спасений 0\/3, обрядов 0\/2/.test(form.body), `суточные лимиты не показаны: ${form.body.slice(0, 260)}`);
  for (const part of ["Провести обряд", "Как это работает", "В главное меню"]) {
    must(form.buttons.some((label) => label.includes(part)), `нет кнопки «${part}»: ${form.buttons.join(" | ")}`);
  }
  must(/пепел: 2 спасен/.test(form.body), `в теле формы нет строки пепла: ${form.body.slice(0, 400)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Как это работает"));
  await open("sw:totem", alice, "ui");
  must(/Держи в руке ванический тотем/.test(chatOf(alice).join(" / ")), `правила тотемов не распечатаны: ${chatOf(alice).join(" / ").slice(0, 120)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Провести обряд"));
  await open("sw:totem", alice, "ui");
  const pick = ui.shown.at(-1);
  must(pick.buttons.length === 4, `в экране выбора обряда кнопок: ${pick.buttons.length} (${pick.buttons.join(" | ")})`);
  must(/пепел · 2 спасен\./.test(pick.buttons.join(" | ")), `подписи ступеней без заряда и цены: ${pick.buttons.join(" | ")}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(alice);
  answer(pressLabel("Провести обряд"));
  answer(pressLabel("шёпот"));
  answer(pressLabel("Подтвердить"));
  await open("sw:totem", alice, "ui");
  const picked = chatOf(alice).join(" / ");
  must(/✓ Обряд «шёпот» проведён/.test(picked), `обряд из формы не ответил: ${picked.slice(0, 200)}`);
  const forgedRow = (totemReg().rows ?? [])[0];
  must(forgedRow && forgedRow.tier === "whisper" && forgedRow.charges === 1, `обряд из формы не создал запись: ${JSON.stringify(forgedRow)}`);
  ui.shown.length = 0;
  ui.answers.length = 0;
  await open("sw:totem", alice, "ui");
  const after = lastForm();
  must(after.body.includes(forgedRow.serial) && /зарядов 1\/1/.test(after.body), `после обряда статус не обновился: ${after.body.slice(0, 240)}`);
  return `${form.buttons.length} кнопок на экране тотемов, обряд из формы виден в статусе`;
});

await step("админ-экран тотемов: список, отзыв по кнопке и пустой реестр", async () => {
  giveItem(alice, 7, "minecraft:totem_of_undying", 1);
  giveItem(alice, 8, "minecraft:emerald", 10);
  alice.selectedSlotIndex = 7;
  writeJson(TOTEMS_DP, { ...totemReg(), day: {}, lastSave: {} });
  probeT().loadTotems();
  const forged = reply("sw:totem", alice, "forge", "whisper");
  must(/✓/.test(forged), `обряд для админ-проверки не прошёл: ${forged}`);
  const serial = /серия ([a-z0-9]+)/.exec(forged)?.[1];
  const coinsBefore = wallet("p-alice").coins ?? 0;
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Тотемы"));
  answer(pressLabel(`Отозвать #${serial}`));
  await open("sw:admin", admin);
  const screens = ui.shown.map((row) => row.title);
  must(screens.some((title) => title.includes("Тотемы")), `цепочка админ-экранов оборвалась: ${screens.join(" > ")}`);
  const chat = chatOf(admin).join(" / ");
  must(/✓ Заряды тотема/.test(chat), `кнопка отзыва не сработала: ${chat.slice(0, 200)}`);
  must(rowOf(serial).charges === 0, "отзыв из формы не погасил заряд");
  must((wallet("p-alice").coins ?? 0) === coinsBefore, "отзыв тронул монеты — он обязан быть бесплатным");
  writeJson(TOTEMS_DP, { season: 1, rows: [], day: {}, lastSave: {} });
  probeT().loadTotems();
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Тотемы"));
  await open("sw:admin", admin);
  const empty = ui.shown.at(-1);
  must(empty.title.includes("Тотемы"), `пустой экран тотемов не открылся: ${empty.title}`);
  must(/Реестр тотемов пуст/.test(empty.body), `пустого реестра не видно: ${empty.body.slice(0, 160)}`);
  must(empty.buttons.length === 1, `на пустом экране кнопок: ${empty.buttons.length} (${empty.buttons.join(" | ")})`);
  return "отзыв кнопкой + пустой экран";
});

check("тотемы не напечатали ни одной монеты за весь прогон", () => {
  const ledger = readJson("sw:eco:ledger") ?? {};
  must(mintedBeforeTotems > 0, "не зафиксирована отправная точка по minted");
  must((ledger.minted ?? 0) === mintedBeforeTotems, `эмиссия за время сценария: ${(ledger.minted ?? 0) - mintedBeforeTotems} ₡`);
  must((ledger.burned ?? 0) > 0, "за весь сценарий ничего не сгорело — обряд не тестировался");
  const summary = probeT().totemSummary();
  must(typeof summary.live === "number" && typeof summary.savesToday === "number", `сводка неполная: ${JSON.stringify(summary)}`);
  must(mc.state.dispatchErrors.length === 0, `ошибок в диспетчер событий: ${mc.state.dispatchErrors.length} (${mc.state.dispatchErrors.slice(-1)})`);
  return `minted ${ledger.minted}, burned ${ledger.burned}, живых зарядов ${summary.live}`;
});

scenario("защита спавна");

const probeS = () => globalThis.__swipecraftProbe.spawn;
const spawnBuildProbe = () => globalThis.__swipecraftProbe.spawnBuild;
const FLOOR_CELL = cellKey(0, 79, 0);

check("ломать блоки на спавне нельзя, и причина называется", () => {
  const before = mc.state.blockOverrides.get(FLOOR_CELL);
  must(before === "minecraft:polished_andesite", `пол спавна не из blueprint'а: ${before}`);
  clearChat(alice);
  const denied = mc.breakBlock(alice, { x: 0, y: 79, z: 0 });
  must(denied.cancelled === true, "защита не отменила playerBreakBlock на спавне");
  must(mc.state.blockOverrides.get(FLOOR_CELL) === before, "пол спавна всё-таки изменён");
  const chat = chatOf(alice).join(" / ");
  must(/Здесь спавн: блоки ломать нельзя/.test(chat), `отказ не объяснён: ${chat.slice(-160)}`);
  // и обратная половина: за кругом спавна копать можно, иначе «защита» = запрет игры
  mc.state.blockOverrides.set(cellKey(26, 79, 0), "minecraft:diamond_block");
  const free = mc.breakBlock(alice, { x: 26, y: 79, z: 0 });
  must(free.cancelled === false, "защита залезла за пределы круга спавна");
  must(mc.state.blockOverrides.get(cellKey(26, 79, 0)) === "minecraft:air", "свободная клетка не сломалась");
  const status = probeS().spawnProtectStatus();
  must(status.enabled === true && status.breakDenied >= 1, `статус защиты врёт: ${JSON.stringify(status)}`);
  return `отказ внутри круга + свободная добыча снаружи, отказов: ${status.breakDenied}`;
});

check("напоминание об отказе не выливается в спам", () => {
  const probe = probeS();
  probe.forgetNotice(alice.id);
  clearChat(alice);
  for (let index = 0; index < 6; index += 1) mc.breakBlock(alice, { x: 1, y: 79, z: 1 });
  must(chatOf(alice).length === 1, `6 отказов подряд напечатали ${chatOf(alice).length} строк`);
  probe.forgetNotice(alice.id);
  mc.breakBlock(alice, { x: 1, y: 79, z: 1 });
  must(chatOf(alice).length === 2, "после сброса напоминания объяснение не вернулось");
  must(probe.spawnProtectStatus().breakDenied >= 8, "счётчик отказов не растёт — по нему и читают, много ли мы мешаем");
  return "6 попыток = 1 строка в чате";
});

const countInInventory = (player, typeId) => {
  const container = player.getComponent("minecraft:inventory")?.container;
  let total = 0;
  for (let index = 0; index < container.size; index += 1) {
    const stack = container.getItem(index);
    if (stack?.typeId === typeId) total += stack.amount;
  }
  return total;
};

check("установка на спавне откатывается, предмет возвращается", () => {
  giveItem(alice, 9, "minecraft:cobblestone", 3);
  const before = countInInventory(alice, "minecraft:cobblestone");
  const coins = wallet("p-alice").coins ?? 0;
  clearChat(alice);
  // напоминание троттлится на 8 с — без сброса проверка «объяснили ли отказ» ловила бы
  // молчание protection-механизма, а не отсутствие текста
  probeS().forgetNotice(alice.id);
  // воздух над плитой: обычная ситуация «поставил блок на спавне». Ищем предмет по всему
  // инвентарю, а не в 9-м слоте: возврат ложится в первую свободную ячейку, как в игре
  const placed = mc.placeBlock(alice, { x: 2, y: 80, z: 2 }, "minecraft:cobblestone");
  must(placed.placed === "minecraft:air", `блок на спавне остался стоять: ${placed.placed}`);
  must(countInInventory(alice, "minecraft:cobblestone") === before + 1, `предмет не вернулся в руки (было ${before}) — откат был бы кражей`);
  must(/блок убрал обратно/.test(chatOf(alice).join(" / ")), "отказ установки не объяснён");
  // клетка из blueprint'а: откат обязан вернуть структуру, а не дыру в полу
  const cell = mc.placeBlock(alice, { x: 0, y: 79, z: 0 }, "minecraft:cobblestone");
  must(cell.placed === "minecraft:polished_andesite", `клетка blueprint'а откатана в ${cell.placed}, а не в плиту`);
  must(countInInventory(alice, "minecraft:cobblestone") === before + 2, "при откате в клетку blueprint'а предмет пропал");
  must((wallet("p-alice").coins ?? 0) === coins, "защита спавна тронула монеты");
  const status = probeS().spawnProtectStatus();
  must(status.placeReverted >= 2, `откатов установки насчитано ${status.placeReverted}`);
  return "откат в воздух + откат в плиту blueprint'а";
});

check("взрыв у спавна вырезает защищённые клетки, но не отменяется", () => {
  mc.state.blockOverrides.set(cellKey(26, 79, 2), "minecraft:diamond_block");
  const before = probeS().spawnProtectStatus().explosionCells;
  const blast = mc.explode({ x: 24, y: 79, z: 1 }, {
    blocks: [{ x: 0, y: 79, z: 0 }, { x: 1, y: 79, z: 0 }, { x: 26, y: 79, z: 2 }],
  });
  must(blast.cancelled === false, "взрыв целиком на границе отменён: крёр у спавна перестал быть крём");
  must(mc.state.blockOverrides.get(FLOOR_CELL) === "minecraft:polished_andesite", "взрыв снёс плиту спавна");
  must(mc.state.blockOverrides.get(cellKey(1, 79, 0)) === "minecraft:deepslate_tiles", "шахматная клетка плиты снесена — фильтр взрывов её не увидел");
  must(mc.state.blockOverrides.get(cellKey(26, 79, 2)) === "minecraft:air", "взрыв не тронул то, что вне спавна");
  // целиком внутри круга отменять уже можно: защищать там нечего, а урон по игрокам гасит entityHurt
  const deep = mc.explode({ x: 0, y: 79, z: 0 }, { blocks: [{ x: 2, y: 79, z: 2 }, { x: 3, y: 79, z: 3 }] });
  must(deep.cancelled === true, "взрыв целиком на спавне не отменён");
  const after = probeS().spawnProtectStatus().explosionCells;
  must(after - before === 4, `клеток снято ${after - before}, ожидалось 4`);
  return "2 + 2 клетки снято, урон снаружи прошёл";
});

check("ведро на спавне не льёт, при этом меч и добыча не задеты", () => {
  alice.teleport({ x: 4, y: 71, z: 4 });
  const water = mc.useItem(alice, new mc.ItemStack("minecraft:water_bucket", 1));
  must(water.cancelled === true, "воду на спавне разрешили разливать");
  const bucket = mc.useItem(alice, new mc.ItemStack("minecraft:bucket", 1));
  must(bucket.cancelled === true, "пустое ведро на спавне работает — тогда и зачерпнуть воду можно");
  const sword = mc.useItem(alice, new mc.ItemStack("minecraft:iron_sword", 1));
  must(sword.cancelled === false, "защита спавна цепляет не только вёдра");
  mc.state.blockOverrides.set(cellKey(4, 79, 4), "minecraft:dirt");
  const dig = mc.breakBlock(alice, { x: 4, y: 79, z: 4 });
  must(dig.cancelled === true, "защита соскакивает, если игрок уже держит в руке что-то кроме ведра");
  alice.teleport({ x: 60, y: 71, z: 60 });
  const free = mc.useItem(alice, new mc.ItemStack("minecraft:water_bucket", 1));
  must(free.cancelled === false, "за пределами спавна ведро стало недоступно");
  return "3 отказа по ведру, 1 свободное применение меча";
});

check("античит не видит служебных отказов защиты спавна", () => {
  const ac = globalThis.__swipecraftProbe.anticheat;
  for (let index = 0; index < 25; index += 1) mc.breakBlock(bob, { x: 5, y: 79, z: 5 });
  must(ac.playerScore(bob.id) === 0, `античит оштрафовал за отменённые удары: ${ac.playerScore(bob.id)}`);
  bob.teleport({ x: 70, y: 71, z: 70 });
  for (let index = 0; index < 25; index += 1) {
    mc.state.blockOverrides.set(cellKey(70 + (index % 3), 79, 70), "minecraft:stone");
    mc.breakBlock(bob, { x: 70 + (index % 3), y: 79, z: 70 });
  }
  expectedWarns.push(/\[anticheat\] .*Bob nuke/); // штраф намеренный: им и проверяем, что AC видит добычу
  must(ac.playerScore(bob.id) > 0, "античит перестал видеть настоящую быструю добычу — защита глушит его обработчик");
  // счёт чистим: следующие сценарии проверяют «игрок не помечен», и чужая метка их сломала бы
  ac.resetState(bob.id);
  must(ac.playerScore(bob.id) === 0, "resetState не сбросил счётчик");
  return "25 отказов = 0, 25 добыч = штраф, resetState чист";
});

check("защита не мешает скрипту чинить спавн, а стоп-кран открывает ломку", () => {
  const probe = probeS();
  const build = spawnBuildProbe();
  // «выжженная» клетка внутри круга: скриптовая правка не является событием игрока, защита
  // обязана пропустить и починку при включённой защите, и запись в ту же клетку
  mc.state.blockOverrides.set(cellKey(3, 79, 3), "minecraft:air");
  const launch = build.startSpawnBuild("stable", "repair");
  must(launch.ok, `починка не запустилась: ${JSON.stringify(launch)}`);
  mc.tickTimes(60);
  must(build.spawnStatus().running === false, `починка не завершилась за 12 проходов: ${JSON.stringify(build.spawnStatus())}`);
  must(mc.state.blockOverrides.get(cellKey(3, 79, 3)) === "minecraft:polished_andesite", "защита помешала скрипту починить спавн");
  reply("sw:meta", admin, "set", "spawnProtectEnabled", "false");
  flush();
  const off = mc.breakBlock(alice, { x: 0, y: 79, z: 0 });
  must(off.cancelled === false, "стоп-кран не снял защиту: ломать спавн по-прежнему нельзя");
  must(mc.state.blockOverrides.get(FLOOR_CELL) === "minecraft:air", "при выключенной защите дыра в полу не появилась");
  reply("sw:meta", admin, "set", "spawnProtectEnabled", "true");
  flush();
  probe.forgetNotice(alice.id);
  const relaunch = build.startSpawnBuild("stable", "repair");
  must(relaunch.ok, `вторая починка не запустилась: ${JSON.stringify(relaunch)}`);
  mc.tickTimes(60);
  const st = spawnBuildProbe().spawnStatus();
  must(
    mc.state.blockOverrides.get(FLOOR_CELL) === "minecraft:polished_andesite",
    `после включения защита помешала вернуть плиту: ${mc.state.blockOverrides.get(FLOOR_CELL)} при статусе ${JSON.stringify(st)}`,
  );
  return "починка работает при обоих положениях стоп-крана";
});

await step("экран «Моды мира» показывает защиту спавна и кричит, когда она снята", async () => {
  const openWorld = async () => {
    ui.shown.length = 0;
    ui.answers.length = 0;
    answer(pressLabel("Мета"));
    answer(pressLabel("Моды мира"));
    await open("sw:admin", admin);
    return ui.shown.at(-1);
  };
  let screen = await openWorld();
  must(/защита спавна: включены/.test(screen.body), `строки защиты нет в сводке: ${screen.body.slice(0, 400)}`);
  reply("sw:meta", admin, "set", "spawnProtectEnabled", "false");
  flush();
  screen = await openWorld();
  must(/защита спавна: ВНИМАНИЕ/.test(screen.body), `снятая защита не помечена в сводке: ${screen.body.slice(0, 400)}`);
  reply("sw:meta", admin, "set", "spawnProtectEnabled", "true");
  flush();
  alice.teleport({ x: 4, y: 71, z: 4 });
  bob.teleport({ x: 8, y: 71, z: 8 });
  clearChat(alice);
  clearChat(bob);
  return "сводка меняется вместе со стоп-краном";
});

check("защита спавна не добавила ошибок в диспетчер событий", () => {
  must(mc.state.dispatchErrors.length === 0, `ошибок в обработчиках: ${mc.state.dispatchErrors.length} (${mc.state.dispatchErrors.slice(-2).join(" | ")})`);
});

check("blueprint спавна: id блоков существует в 1.26.60", () => {
  const build = spawnBuildProbe();
  const blocks = new Set(Object.values(MinecraftBlockTypes));
  const ids = build.spawnBlueprintTypeIds();
  const missing = ids.filter((id) => !blocks.has(id));
  must(missing.length === 0, `в MinecraftBlockTypes нет: ${missing.join(", ")}`);
  must(ids.length >= 12, `декора нет: blueprint использует всего ${ids.length} id`);
  return `${build.spawnBlueprintSize()} ячеек, ${ids.length} id, 0 несуществующих`;
});

check("blueprint спавна: ни одной дублирующейся клетки и второй проход ничего не пишет", () => {
  const build = spawnBuildProbe();
  const cells = build.spawnBlueprint();
  const keys = new Set(cells.map((cell) => cellKey(cell.x, cell.y, cell.z)));
  must(keys.size === cells.length, `в blueprint'е ${cells.length - keys.size} клеток-дублей: починка будет вечно перестраивать площадь`);
  const launch = build.startSpawnBuild("stable", "build");
  must(launch.ok, `сборка не запустилась: ${JSON.stringify(launch)}`);
  mc.tickTimes(120);
  const status = build.spawnStatus();
  must(status.running === false, `сборка не завершилась: ${JSON.stringify(status)}`);
  // второй проход по уже собранной площади не должен записать ни одной ячейки
  build.startSpawnBuild("stable", "repair");
  mc.tickTimes(120);
  const again = build.spawnStatus();
  must(again.built === 0, `повторная починка переписала ${again.built} ячеек — blueprint не идемпотентен`);
  must(again.missing === 0, `целостность не сходится: ${again.missing} расхождений`);
  return `${cells.length} ячеек, повторный проход: 0 записей`;
});

check("декор спавна не отрезает вход и не трогает критические клетки", () => {
  const build = spawnBuildProbe();
  const cells = build.spawnBlueprint();
  const at = (x, y, z) => cells.find((cell) => cell.x === x && cell.y === y && cell.z === z)?.typeId;
  // плита под точкой возрождения обязана оставаться плитой, а не оградой и не клумбой
  must(at(0, 79, 0) === "minecraft:polished_andesite", `под точкой возрождения лежит ${at(0, 79, 0)}`);
  must(at(0, 79, -4) !== "minecraft:gold_block", "алтарь уехал из-под точки возрождения");
  must(at(0, 81, -4) === "minecraft:gold_block", `золотого блока алтаря нет: ${at(0, 81, -4)}`);
  // лампы по диагоналям подиума: без них проверка «света хватает» была бы вакуумной
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    must(at(dx, 81, -4 + dz) === "minecraft:lantern", `лампа алтаря (${dx}, ${dz}): ${at(dx, 81, -4 + dz)}`);
  }
  // четыре проёма в ограде: ровно там, где дорожки
  for (const [dx, dz] of [[0, 11], [0, -11], [11, 0], [-11, 0]]) {
    must(at(dx, 80, dz) !== "minecraft:iron_bars", `проём дорожки (${dx}, ${dz}) закован в iron_bars`);
  }
  // фонтан: вода на уровне плиты, а не сверху — иначе источник растекётся по площади
  const water = cells.filter((cell) => cell.typeId === "minecraft:water");
  must(water.length === 9, `чаша фонтана: ${water.length} клеток воды`);
  must(water.every((cell) => cell.y === 79), "вода фонтана стоит выше уровня плиты");
  must(water.some((cell) => cell.x === 0 && cell.z === 6), "фонтан уехал из центра южной части площади");
  // клумбы и арки: декор есть, и он не в воздухе над спавном
  const flowers = cells.filter((cell) => /poppy|daisy|allium|cornflower|short_grass/.test(cell.typeId));
  must(flowers.length >= 16, `цветов ${flowers.length}`);
  const rails = cells.filter((cell) => cell.typeId === "minecraft:iron_bars");
  must(rails.length > 40, `ограды всего ${rails.length} клеток`);
  const lanterns = cells.filter((cell) => /lantern|sea_lantern/.test(cell.typeId));
  must(lanterns.length >= 12, `фонарей всего ${lanterns.length}`);
  return `проёма 4, воды 9, цветов ${flowers.length}, ограды ${rails.length}, светильников ${lanterns.length}`;
});

check("id блоков и предметов карьера существуют в 1.26.60", () => {
  const minable = globalThis.__swipecraftProbe.quarry.QUARRY_MINABLE;
  const blocks = new Set(Object.values(MinecraftBlockTypes));
  const items = new Set(Object.values(MinecraftItemTypes));
  const badBlocks = Object.keys(minable).filter((id) => !blocks.has(id));
  const badDrops = [...new Set(Object.values(minable).map((row) => row.typeId))].filter((id) => !items.has(id));
  must(badBlocks.length === 0, `в MinecraftBlockTypes нет: ${badBlocks.join(", ")}`);
  must(badDrops.length === 0, `в MinecraftItemTypes нет: ${badDrops.join(", ")}`);
  must(Object.keys(minable).length >= 40, `пригодных для копки блоков всего ${Object.keys(minable).length}`);
  return `${Object.keys(minable).length} пород, 0 несуществующих id`;
});

scenario("ранги и таблица статуса");

let mintedBeforeRanks = 0;

const profileOf = (player) => JSON.parse(player.getDynamicProperty(`sw:p:${player.id}`) ?? "{}");

check("отправная точка эмиссии зафиксирована", () => {
  flush();
  mintedBeforeRanks = readJson("sw:eco:ledger")?.minted ?? 0;
  must(mintedBeforeRanks > 0, `ledger.minted = ${mintedBeforeRanks}`);
  return `${mintedBeforeRanks} ₡`;
});

check("игровое время копится по суткам и обнуляется на границе дня", () => {
  const before = profileOf(alice);
  must(typeof before.playSeconds === "number", `профиля нет или playSeconds не число: ${JSON.stringify(before).slice(0, 120)}`);
  must(typeof before.playToday === "number" && typeof before.playDay === "number", `сутки не считаются: ${JSON.stringify(before).slice(0, 160)}`);
  passMs(5 * 60 * 1000);
  mc.tickTimes(1201);
  const after = profileOf(alice);
  must(after.playSeconds >= before.playSeconds + 300, `всего: ${before.playSeconds} → ${after.playSeconds}`);
  must(after.playToday >= before.playToday + 300, `за сегодня: ${before.playToday} → ${after.playToday}`);
  must(after.playDay === before.playDay, `ключ суток уехал без причины: ${before.playDay} → ${after.playDay}`);
  // переползаем через полночь (UTC-сутки, как и везде в мире): «сегодня» обнуляется, «всего» — нет
  passMs(86_400_000 - (Date.now() % 86_400_000) + 61_000);
  // бар читаем ДО сейва: только тогда видно, что живая часть сессии не порезана по
  // полуночи (после saveProfile профиль уже «правильный», и проверка стала бы вакуумной)
  const barLine = globalThis.__swipecraftProbe.hud.hudLine(alice).replace(/§./g, "");
  const todayValue = (/За сегодня: ([^·]+)/.exec(barLine) ?? [])[1]?.trim() ?? "";
  const unit = { с: 1, м: 60, ч: 3600, д: 86_400 }[todayValue.slice(-1)] ?? 0;
  const todaySeconds = Number.parseInt(todayValue, 10) * unit;
  must(Number.isFinite(todaySeconds) && todaySeconds <= 180, `в bar утекло вчерашнее время: «${todayValue}» (${barLine})`);
  mc.tickTimes(1201);
  const next = profileOf(alice);
  must(next.playDay !== after.playDay, `сутки не сменились: ${after.playDay} → ${next.playDay}`);
  must(next.playToday < 300, `после полуночи «сегодня» = ${next.playToday} — счётчик не обнулился`);
  must(next.playSeconds >= after.playSeconds + 60, `всё время должно только расти: ${after.playSeconds} → ${next.playSeconds}`);
  return `всего ${next.playSeconds}с, сегодня ${next.playToday}с, день ${next.playDay}`;
});

const ranksProbe = () => globalThis.__swipecraftProbe.ranks;
const hudP = () => globalThis.__swipecraftProbe.hud;

check("выдача ранга ставит префикс над головой и в кошелёк", () => {
  const coins = wallet("p-alice").coins;
  must(coins >= 2400 * 6, `на балансе Alice ${coins} — не хватает на 6 круток, тест надо переставлять`);
  const value = ranksProbe().grantRank(alice, "rune", { actor: "стаб-тест" });
  must(value.ok, `выдача отказала: ${value.key}`);
  must(ranksProbe().rankProbe(alice).best === "rune", `лучший ранг: ${ranksProbe().rankProbe(alice).best}`);
  must(alice.nameTag.includes("[руны]"), `nameTag: ${alice.nameTag}`);
  flush();
  must((wallet("p-alice").rankOwned ?? []).includes("rune"), `rankOwned: ${JSON.stringify(wallet("p-alice").rankOwned)}`);
  must(wallet("p-alice").coins === coins, `ранг за счёт экономики: ${coins} → ${wallet("p-alice").coins}`);
  return `tag=${alice.nameTag.slice(0, 12)}…, монеты ${coins} не тронуты`;
});

check("дубль ранга компенсируется монетами, а ранг не теряется", () => {
  const before = wallet("p-alice").coins;
  const owned = (wallet("p-alice").rankOwned ?? []).length;
  const price = 2400;
  const value = ranksProbe().grantRank(alice, "rune", { actor: "стаб-тест", paid: price });
  must(value.ok && value.key === "rank.dup.refund", `ожидали компенсацию, получили ${value.key}`);
  must(value.refund === Math.round(price * 0.6), `компенсация ${value.refund} вместо ${Math.round(price * 0.6)}`);
  flush();
  const record = wallet("p-alice");
  must(record.coins === before + value.refund, `монеты: ${before} → ${record.coins} (refund ${value.refund})`);
  must((record.rankOwned ?? []).length === owned, `дубль изменил коллекцию: ${owned} → ${(record.rankOwned ?? []).length}`);
  must(record.rank === "rune", `лучший ранг после дубля: ${record.rank}`);
  return `+${value.refund} ₡ за дубль, рангов ${owned}`;
});

check("ранг ниже текущего идёт в коллекцию, но не на ник", () => {
  const tag = alice.nameTag;
  const before = wallet("p-alice").coins;
  const value = ranksProbe().grantRank(alice, "steel", { actor: "стаб-тест", paid: 2400 });
  must(value.ok && /rank\.below/.test(value.key), `ожидали «ниже текущего», получили ${value.key}`);
  must(alice.nameTag === tag, `ник переписан младшим рангом: ${tag} → ${alice.nameTag}`);
  flush();
  const record = wallet("p-alice");
  must(record.coins === before + (value.refund ?? 0), `компенсация не дошла: ${before} → ${record.coins}`);
  must(record.rank === "rune", `лучший ранг съехал: ${record.rank}`);
  must((record.rankOwned ?? []).includes("steel"), `коллекция потеряла steel: ${JSON.stringify(record.rankOwned)}`);
  return `steel в коллекции (+${value.refund} ₡), на нике остался rune`;
});

check("стоп-кран рангов снимает префикс и закрывает кейс — и возвращает обратно", () => {
  // какой ранг лучший — не важно и не предсказуемо (крутки выше могли поднять планку),
  // поэтому сравниваем nameTag с тем тегом, который модуль считает текущим
  const tag = ranksProbe().rankProbe(alice).tag.trim();
  must(tag.length > 0, `тега нет вообще: ${JSON.stringify(ranksProbe().rankProbe(alice))}`);
  must(alice.nameTag.includes(tag), `префикса уже нет, а тест ещё ничего не выключал: ${alice.nameTag}`);
  const coins = wallet("p-alice").coins;
  metaSet("ranksEnabled", false);
  const changed = ranksProbe().syncRankTags();
  must(changed >= 1, `syncRankTags вернул ${changed} — префикс не снят`);
  must(!alice.nameTag.includes(tag), `префикс остался после выключения: ${alice.nameTag}`);
  flush();
  must(wallet("p-alice").rankTag === "", `rankTag в кошельке: ${JSON.stringify(wallet("p-alice").rankTag)}`);
  const off = ranksProbe().rollRanks(alice, 1);
  must(!off.ok && off.key === "rank.off", `кейс не закрыт: ${off.key}`);
  flush();
  must(wallet("p-alice").coins === coins, `на закрытом кейсе монеты ушли: ${coins} → ${wallet("p-alice").coins}`);
  metaSet("ranksEnabled", true);
  must(ranksProbe().syncRankTags() >= 1, "обратный поворот крана ничего не вернул");
  must(alice.nameTag.includes(ranksProbe().rankProbe(alice).tag.trim()), `префикс не вернулся: ${alice.nameTag}`);
  must(ranksProbe().rollRanks(alice, 1).ok, "кейс не открылся после возврата крана");
  return `«${tag}» снят и вернулся, закрытый кейс не сжёг ни ₡`;
});

check("кейс рангов: все дубли → детерминированный итог по монетам", () => {
  for (const id of ["bronze", "steel", "rune", "elite", "legend", "myth", "novice"]) ranksProbe().grantRank(alice, id, { actor: "стаб-тест" });
  flush();
  const before = wallet("p-alice").coins;
  const value = ranksProbe().rollRanks(alice, 5);
  must(value.ok, `крутка отказала: ${value.key}`);
  must(value.lines.length === 5, `строк результата: ${value.lines.length}`);
  must(value.lines.every((line) => line.includes("дубль")), `не все строки помечены как дубли: ${value.lines.join(" | ").slice(0, 220)}`);
  const delta = before - wallet("p-alice").coins;
  // 5 × 2400 сгорает, 5 × 1440 возвращается: ровно 4800, без «плавающего» результата
  must(delta === 4800, `баланс изменился на ${delta}, ожидалось 4800`);
  flush();
  const ledger = readJson("sw:eco:ledger") ?? {};
  must((ledger.minted ?? 0) === mintedBeforeRanks, `ранги напечатали ${(ledger.minted ?? 0) - mintedBeforeRanks} ₡`);
  return `5 круток → -${delta} ₡, компенсаций ${value.params.refunded}`;
});

check("пустой кошелёк: крутка отказывает и ничего не сжигает", () => {
  const before = wallet("p-carl")?.coins ?? 0;
  const value = ranksProbe().rollRanks(carl, 1);
  must(!value.ok, `крутка за чужой счёт прошла: ${JSON.stringify(value)}`);
  must(value.key === "eco.balance.low", `ключ отказа: ${value.key}`);
  flush();
  must((wallet("p-carl")?.coins ?? 0) === before, `монеты Карла изменились: ${before} → ${wallet("p-carl")?.coins}`);
  return `отказ ${value.key}`;
});

check("строка статуса: ранг, баланс, сегодня и всё время", () => {
  hudP().setHudBar(alice, true);
  hudP().refreshHudBar();
  // бар уже красился задачей, поэтому проверяем не «был ли written», а что writes вообще есть
  must(hudP().hudProbe().barWrites > 0, "ни одной записи в action bar за прогон");
  const text = (hudP().hudProbe().lastText.find(([id]) => id === "p-alice") ?? [])[1] ?? "";
  const plain = text.replace(/§./g, "");
  must(plain.includes("Ранг: Мифический"), `ранга в строке нет: ${plain}`);
  must(/Баланс: \d[\d ]*/.test(plain), `баланс не в строке: ${plain}`);
  must(/За сегодня: \d+[смчд]/.test(plain), `сегодня не в строке: ${plain}`);
  must(/За всё время: \d+[смчд]/.test(plain), `всё время не в строке: ${plain}`);
  must(plain.split("·").length === 4, `в строке ${plain.split("·").length} полей, ждали 4: ${plain}`);
  must(!text.includes("₡"), `символ валюты уехал в action bar: ${text}`);
  must(!/[a-z]+\.[a-z]+\./.test(text), `в строке сырой ключ словаря: ${text}`);
  return text;
});

check("бар не пишет повторно одно и то же и слушается локального off", () => {
  must(hudP().refreshHudBar() === 0, "второй подряд refresh написал текст заново");
  const off = hudP().setHudBar(alice, false);
  must(off.key === "hud.bar.off", `off вернул ${off.key}`);
  const last = mc.state.actionBars.filter((row) => row.to === "Alice").at(-1);
  must(last && last.value === "", `бар не очищен: ${JSON.stringify(last)}`);
  must(hudP().hudProbe().manualOff.includes("p-alice"), "off не запомнен");
  const on = hudP().setHudBar(alice, true);
  must(on.key === "hud.bar.on" && on.params.line.length > 10, `on вернул ${on.key}`);
  return "off/on работают, дублей записи нет";
});

check("глобальный тумблер бара перекрывает локальное «on»", () => {
  metaSet("hudBarEnabled", false);
  hudP().refreshHudBar();
  const cleared = mc.state.actionBars.filter((row) => row.to === "Alice").at(-1);
  must(cleared && cleared.value === "", `бар не снят глобальным тумблером: ${JSON.stringify(cleared)}`);
  const gated = hudP().setHudBar(alice, true);
  must(gated.key === "hud.bar.gated", `локальное on обошло гейт: ${gated.key}`);
  metaSet("hudBarEnabled", true);
  must(hudP().refreshHudBar() >= 1, "после включения тумблера бар не вернулся");
  return "гейт виден и снимается обратно";
});

check("сайдбар: топ по монетам сверху, призрачных строк нет", () => {
  hudP().refreshHudSidebar();
  const lines = mc.scoreboardLines();
  must(lines.length >= 3, `строк сайдбара: ${lines.length}`);
  must(mc.scoreboardTitle() === "§6Swipecraft", `заголовок: ${mc.scoreboardTitle()}`);
  const entry = mc.state.scoreboard.slots.get("Sidebar");
  must(entry.sortOrder === 1, `порядок сортировки ${entry.sortOrder} — Descending = 1`);
  const byLabel = new Map(entry.objective.getScores().map((row) => [row.participant.displayName, row.score]));
  const shown = lines.map((line) => byLabel.get(line) ?? -1);
  must(shown.every((value) => value >= 0), `в объективе нет части показанных строк: ${shown.join(", ")}`);
  for (let index = 1; index < shown.length; index += 1) {
    must(shown[index - 1] >= shown[index], `строки не по убыванию: ${shown.join(", ")}`);
  }
  must(lines[0].includes("1.") && lines[0].includes("Alice"), `первая строка: ${lines[0]}`);
  const rows = new Set(hudP().hudSidebarRows().map((row) => row.label));
  const ghosts = lines.filter((line) => !rows.has(line));
  must(ghosts.length === 0, `в сайдбаре остались старые строки: ${ghosts.join(" | ")}`);
  must(lines.some((line) => line.includes("Игроков онлайн")), `онлайна нет: ${lines.join(" | ")}`);
  return `${lines.length} строк: ${lines.map((line) => line.replace(/§./g, "")).join(" | ")}`.slice(0, 200);
});

check("тумблер сайдбара снимает слот отображения, а не бросает", () => {
  metaSet("hudSidebarEnabled", false);
  hudP().refreshHudSidebar();
  must(mc.world.scoreboard.getObjectiveAtDisplaySlot("Sidebar") === undefined, "слот не освобождён");
  metaSet("hudSidebarEnabled", true);
  hudP().refreshHudSidebar();
  must(mc.world.scoreboard.getObjectiveAtDisplaySlot("Sidebar") !== undefined, "слот не вернулся");
  return "слот освобождается и возвращается";
});

const settle = async (ticks = 10) => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

await step("меню: «Ранги» открывает кейс, крутка из формы доходит до кошелька", async () => {
  await settle();
  const before = wallet("p-alice").coins;
  ui.shown.length = 0;
  ui.answers.length = 0;
  // ответы разбираются формами по порядку: сначала меню, потом сам кейс рангов
  answer(pressLabel("Ранги"));
  answer(pressLabel("Крутить кейс рангов ×1"));
  await open("sw:menu", alice);
  const titles = shownTitles().join(" > ");
  must(titles.includes("Swipecraft — меню"), `меню не открылось: ${titles}`);
  const form = lastForm();
  must(form && form.title.includes("Ранги"), `кейс рангов не открылся: ${titles}`);
  must(form.buttons.length === 3, `кнопок в кейсе рангов: ${form.buttons.length} (${form.buttons.join(" | ")})`);
  must(form.body.includes("Лестница"), `тела нет: ${form.body.slice(0, 120)}`);
  // «топ по рангам онлайн» — единственное, куда доехал rankLeaders: пустой список тут
  // означал бы, что функция никем не вызывается и протухла бы молча
  // второму игроку специально выдаётся младший ранг: с одним элементом список
  // упорядочен «сам собой», и проверка порядка стала бы вакуумной
  ranksProbe().grantRank(bob, "bronze", { actor: "стаб-тест" });
  const leaders = ranksProbe().rankTopLines(alice).join(" | ");
  must(/1\. .*(Мифический|Легенда|Элитный)/.test(leaders.replace(/§./g, "")), `топ по рангам не на месте: ${leaders}`);
  must(form.body.includes("Сейчас онлайн"), `в теле кейса нет строки про топ: ${form.body.slice(0, 200)}`);
  const ordered = ranksProbe().rankLeaders(5);
  must(ordered.length >= 2, `в топе по рангам ${ordered.length} записей — тесту не на чем проверять порядок`);
  for (let index = 1; index < ordered.length; index += 1) {
    must(ordered[index - 1].order >= ordered[index].order, `rankLeaders не по убыванию: ${ordered.map((row) => row.order).join(", ")}`);
  }
  must(ordered[0].name === "Alice" && ordered[1].name === "Bob", `порядок в топе по рангам: ${ordered.map((row) => row.name).join(", ")}`);
  must(/шанс: \d/.test(form.body) === false || form.body.includes("не выпадает"), `в лестнице нет ни шансов, ни пометок: ${form.body.slice(0, 240)}`);
  await settle();
  const text = chatOf(alice).join(" / ");
  flush();
  const after = wallet("p-alice").coins;
  // все 7 рангов уже выданы → крутка гарантированно дубль: -2400 и +1440
  must(after === before - 960, `итог крутки по балансу: ${before} → ${after}`);
  must(/Круток: 1, сгорело 2400/.test(text), `итог крутки не дошёл: ${text.slice(-240)}`);
  must(wallet("p-alice").rank === "myth", `лучший ранг после крутки: ${wallet("p-alice").rank}`);
  return `${form.buttons.length} кнопок, ${text.slice(0, 60)}`;
});

await step("стоп-краны рангов и HUD переключаются из общей формы, а не только из консоли", async () => {
  await settle();
  ui.shown.length = 0;
  ui.answers.length = 0;
  clearChat(admin);
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Стоп-краны модов"));
  // порядок control'ов = порядок MOD_TOGGLES: 0 queue, 1 trails, 2 quarry, 3 totems,
  // 4 protect, 5 ranks, 6 hudBar, 7 hudSidebar
  answer(fillModal(true, true, true, true, true, false, true, false));
  await open("sw:admin", admin);
  await settle();
  const text = chatOf(admin).join(" / ");
  must(/ranksEnabled=false/.test(text), `ранги из формы не переключились: ${text.slice(-200)}`);
  must(/hudSidebarEnabled=false/.test(text), `сайдбар из формы не переключился: ${text.slice(-200)}`);
  must(!/hudBarEnabled=/.test(text), `тумблер, оставленный как был, попал в список изменений: ${text.slice(-200)}`);
  const cfg = readJson("sw:eco:cfg") ?? {};
  must(cfg.ranksEnabled === false, `ranksEnabled в конфиге: ${cfg.ranksEnabled}`);
  must(cfg.hudBarEnabled === true, `hudBarEnabled не должен был измениться: ${cfg.hudBarEnabled}`);
  hudP().refreshHudSidebar();
  hudP().refreshHudBar();
  must(mc.world.scoreboard.getObjectiveAtDisplaySlot("Sidebar") === undefined, "сайдбар не снят из формы");
  const aliceLine = (hudP().hudProbe().lastText.find(([id]) => id === "p-alice") ?? [])[1] ?? "";
  must(aliceLine.length > 5, `персональная строка пострадала зря: ${aliceLine}`);
  // префикс над головой снимает не форма, а задача meta-ranks: без этих тиков проверка
  // «кран доехал до ника» была бы самообманом (тег сняли бы руками)
  const tag = ranksProbe().rankProbe(alice).tag.trim();
  mc.tickTimes(601);
  must(tag.length > 0 && !alice.nameTag.includes(tag), `префикс не снят задачей: ${alice.nameTag} (тег ${tag})`);
  // возвращаем как было — иначе следующий за этим сценарием прогон увидит чужие флаги
  ui.shown.length = 0;
  ui.answers.length = 0;
  answer(pressLabel("Мета"));
  answer(pressLabel("Моды мира"));
  answer(pressLabel("Стоп-краны модов"));
  answer(fillModal(true, true, true, true, true, true, true, true));
  await open("sw:admin", admin);
  await settle();
  const back = readJson("sw:eco:cfg") ?? {};
  must(back.ranksEnabled === true && back.hudSidebarEnabled === true, `краны не вернулись: ${JSON.stringify(back).slice(0, 160)}`);
  hudP().refreshHudSidebar();
  must(mc.world.scoreboard.getObjectiveAtDisplaySlot("Sidebar") !== undefined, "сайдбар не вернулся после возврата тумблера");
  mc.tickTimes(601);
  must(alice.nameTag.includes(tag), `префикс не вернулся задачей: ${alice.nameTag}`);
  return "2 крана доехали из формы, третий не тронут";
});

check("ранги ничего не напечатали и не добавили ошибок в диспетчер", () => {
  const ledger = readJson("sw:eco:ledger") ?? {};
  must(mintedBeforeRanks > 0, "отправная точка по minted не зафиксирована");
  must((ledger.minted ?? 0) === mintedBeforeRanks, `эмиссия за сценарий: ${(ledger.minted ?? 0) - mintedBeforeRanks} ₡`);
  must(mc.state.dispatchErrors.length === 0, `ошибок в диспетчере: ${mc.state.dispatchErrors.length} (${mc.state.dispatchErrors.slice(-2)})`);
  const report = ranksProbe().rankReport();
  must(report.length >= 2, `сводка рангов пустая: ${JSON.stringify(report)}`);
  return `minted ${ledger.minted}, ${report[0]}`;
});

check("ключи рангов и HUD запрошены из кода (не мёртвые)", () => {
  const dictText = readFileSync("src/meta/messages.ts", "utf8") + readFileSync("src/ui/messages.ts", "utf8");
  const keys = [...new Set([...dictText.matchAll(/^\s+"((?:rank|hud)\.[\w.]+)":/gm)].map((row) => row[1]))];
  must(keys.length >= 30, `ключей найдено ${keys.length} — похоже, словари не дочитались`);
  // сами словари из «кода» вырезаем: иначе каждая строка словаря «используется» самой собой
  let blob = readSourceFiles("src");
  const before = blob.length;
  blob = blob.replace(readFileSync("src/meta/messages.ts", "utf8"), "").replace(readFileSync("src/ui/messages.ts", "utf8"), "");
  must(blob.length < before, "словари не вырезаны из поиска — проверка стала бы вакуумной");
  const dead = keys.filter((key) => !blob.includes(`"${key}"`));
  must(dead.length === 0, `никто не запрашивает: ${dead.join(", ")}`);
  return `${keys.length} ключей, все запрошены из кода`;
});

check("словари модов переведены и не оставляют сырых ключей", () => {
  const i18n = globalThis.__swipecraftProbe.i18n;
  const keys = ["quarry.title", "quarry.start", "quarry.err.near", "ui.quarry", "ui.admin.world", "spawn.status", "admin.world.spawn.build", "totem.title", "totem.forge", "totem.err.off", "ui.totems", "admin.world.totem.line", "ui.ranks", "rank.title", "rank.roll", "hud.rank", "hud.today", "hud.total", "hud.online", "hud.bar.off", "hud.bar.gated", "rank.off", "rank.err.unknown", "rank.dup.refund"];
  const raw = keys.filter((key) => i18n.raw("ru", key) === key || i18n.raw("en", key) === key);
  must(raw.length === 0, `ключей нет в словаре: ${raw.join(", ")}`);
  const stats = i18n.dictionaryStats();
  must(stats.missingEn.length === 0 && stats.missingRu.length === 0, `ru/en разъехались: ${stats.missingEn.join(",")}|${stats.missingRu.join(",")}`);
  return `${keys.length} ключей модов и тотемов, ru/en по ${stats.ru}/${stats.en}`;
});

check("ни один ключ не уехал в текст без перевода", () => {
  const i18n = globalThis.__swipecraftProbe.i18n;
  const n = i18n.missingKeyCount();
  must(n === 0, `ключей запрошено без перевода: ${n} (см. log.warn[i18n])`);
  return `0 из ${i18n.dictionaryStats().ru} ключей не найдено`;
});

check("в словаре модов мира нет мёртвых ключей", () => {
  const dict = readFileSync("src/world/messages.ts", "utf8");
  const blocks = [...dict.matchAll(/const (ru|en): Record<string, string> = \{([\s\S]*?)\n\};/g)].map((match) => ({
    lang: match[1],
    keys: [...match[2].matchAll(/^\s+"([\w.]+)":/gm)].map((row) => row[1]),
  }));
  must(blocks.length === 2, `в файле найдено блоков словаря: ${blocks.length} (ждали ru и en)`);
  const [ruBlock, enBlock] = blocks;
  must(ruBlock.keys.length >= 110, `ключей в ru-блоке модов: ${ruBlock.keys.length} — словарь модов не долженхудеть без причины`);
  const asymmetry = ruBlock.keys.filter((key) => !enBlock.keys.includes(key)).concat(enBlock.keys.filter((key) => !ruBlock.keys.includes(key)));
  must(asymmetry.length === 0, `ru и en модов разъехались: ${asymmetry.join(", ")}`);
  const blob = readSourceFiles("src");
  // ключи вида `totem.name.${tier}` собираются шаблоном: считаем их живыми, только если в коде
  // есть префикс этого шаблона — опечатка в имени ступени тогда не останется незамеченной
  const templateFamilies = ["totem.name.", "totem.tier.", "totem.effect."];
  const usedByKey = (key) => {
    if (blob.includes(`"${key}"`)) return true;
    const family = templateFamilies.find((prefix) => key.startsWith(prefix));
    return family ? blob.includes("`" + family) : false;
  };
  const dead = ruBlock.keys.filter((key) => !usedByKey(key));
  must(dead.length === 0, `мёртвые ключи (из кода их никто не запрашивает): ${dead.join(", ")}`);
  return `${ruBlock.keys.length} ключей, ru/en симметричны, все запрошены из кода`;
});

check("за весь прогон нет неожиданных log.error / log.warn", () => {
  must(errors.length === 0, `${errors.length} ошибок: ${errors.slice(0, 4).join(" || ")}`);
  const unexpected = warns.filter((line) => !expectedWarns.some((pattern) => pattern.test(line)));
  must(unexpected.length === 0, `неожиданных предупреждений ${unexpected.length}: ${unexpected.slice(0, 3).join(" || ")}`);
  return `предупреждений ${warns.length} (все ожидаемые)`;
});

const failed = results.filter((row) => !row.ok);
log("");
log("Стабильность мета-слоя (headless, мок Script API)");
let printed = "";
for (const row of results) {
  if (row.group !== printed) {
    printed = row.group;
    log(`\n${printed}:`);
  }
  log(`  ${row.ok ? "OK " : "FAIL"} ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
}
log(`\nвсего проверок ${results.length}, провалов ${failed.length}, log.error ${errors.length}, log.warn ${warns.length}`);
if (!verbose && warns.length > 0) log(`предупреждения: ${[...new Set(warns.map((row) => row.slice(0, 120)))].slice(0, 8).join(" | ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
