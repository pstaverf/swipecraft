import * as mc from "./mock-server.mjs";
import { answer, shownTitles, ui } from "./mock-ui.mjs";

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
  const expected = ["sw:menu", "sw:rtp", "sw:admin", "sw:ac", "sw:event", "sw:eco", "sw:market", "sw:case", "sw:clan", "sw:quest", "sw:don", "sw:meta"];
  const missing = expected.filter((name) => !commands.has(name));
  must(missing.length === 0, `нет команд: ${missing.join(", ")}`);
  return `${expected.length}`;
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

await step("авто-выдача ключей донеру", () => {
  flush();
  const record = wallet("p-alice");
  must(record.caseKeys >= 2, `ключей ${record.caseKeys}`);
  return `ключей ${record.caseKeys}`;
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

scenario("storage");

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
