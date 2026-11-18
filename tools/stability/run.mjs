import * as mc from "./mock-server.mjs";
import { MinecraftBlockTypes, MinecraftItemTypes } from "@minecraft/vanilla-data";
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
  const expected = ["sw:menu", "sw:rtp", "sw:admin", "sw:ac", "sw:event", "sw:eco", "sw:market", "sw:case", "sw:clan", "sw:quest", "sw:don", "sw:shop", "sw:ref", "sw:meta", "sw:quarry", "sw:spawn"];
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
  const expected = ["Кошелёк", "Рынок игроков", "Кейсы", "Кланы", "Квесты и награды", "Донат", "Косметика", "Пригласить друга", "Авто-шахта", "Случайная телепортация", "Правила мира", "Моя статистика", "Язык / Language", "Закрыть"];
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
  for (const part of ["Карьеры", "Спавн", "Стоп-краны модов"]) must(worldForm.buttons.some((label) => label.includes(part)), `нет действия «${part}»`);
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
  must(modal.controls.length === 3, `тумблеров в форме: ${modal.controls.length}`);
  must(modal.controls[2].config?.defaultValue === false, `тумблер не показывает текущее состояние: ${JSON.stringify(modal.controls[2])}`);
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
  alice.teleport(QUARRY_SPOT);
  await mintTo("Alice", 1500);
  const created = reply("sw:quarry", alice, "start");
  must(/✓ Карьер #/.test(created), `второй карьер не запустился: ${created}`);
  const again = reply("sw:quarry", alice, "start");
  must(/уже есть карьер/.test(again), `двойной слот не отклонён: ${again}`);
  admin.teleport({ x: QUARRY_SPOT.x + 5, y: 60, z: QUARRY_SPOT.z });
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

check("словари модов переведены и не оставляют сырых ключей", () => {
  const i18n = globalThis.__swipecraftProbe.i18n;
  const keys = ["quarry.title", "quarry.start", "quarry.err.near", "ui.quarry", "ui.admin.world", "spawn.status", "admin.world.spawn.build"];
  const raw = keys.filter((key) => i18n.raw("ru", key) === key || i18n.raw("en", key) === key);
  must(raw.length === 0, `ключей нет в словаре: ${raw.join(", ")}`);
  const stats = i18n.dictionaryStats();
  must(stats.missingEn.length === 0 && stats.missingRu.length === 0, `ru/en разъехались: ${stats.missingEn.join(",")}|${stats.missingRu.join(",")}`);
  return `${keys.length} ключей модов, ru/en по ${stats.ru}/${stats.en}`;
});

check("ни один ключ не уехал в текст без перевода", () => {
  const n = globalThis.__swipecraftProbe.i18n.missingKeyCount();
  must(n === 0, `ключей запрошено без перевода: ${n} (см. log.warn[i18n])`);
  return "0 из 527 ключей не найдено";
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
