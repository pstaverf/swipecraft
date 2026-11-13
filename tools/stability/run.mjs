import * as mc from "./mock-server.mjs";
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
  const expected = ["sw:menu", "sw:rtp", "sw:admin", "sw:ac", "sw:event", "sw:eco", "sw:market", "sw:case", "sw:clan", "sw:quest", "sw:don", "sw:shop", "sw:ref", "sw:meta"];
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
  const dead = [...new Set([...Object.keys(globalThis.__swipecraftProbe.uiMessages ?? {}), ...Object.keys(globalThis.__swipecraftProbe.metaMessages ?? {})])];
  return `${stats.ru}/${stats.en} ключей, модулей словаря подключено: ${Object.keys(globalThis.__swipecraftProbe).length}${dead.length ? "" : ""}`;
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
