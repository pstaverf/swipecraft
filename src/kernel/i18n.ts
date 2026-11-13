import { Player } from "@minecraft/server";
import type { Lang } from "../types/domain";

type Dict = Record<string, string>;

const ru: Dict = {
  "menu.title": "Swipecraft — меню",
  "menu.body": "Анархия: PvP везде, кроме лобби. Мир сезонный, граница сужается каждую неделю.",
  "menu.rtp": "Случайная телепортация",
  "menu.rules": "Правила мира",
  "menu.stats": "Моя статистика",
  "menu.lang": "Язык / Language",
  "menu.admin": "Админ-панель",
  "menu.close": "Закрыть",
  "rtp.ready": "Ищу безопасное место...",
  "rtp.done": "Телепорт выполнен: {x} {y} {z}. До границы {border} блоков.",
  "rtp.cooldown": "Телепорт будет доступен через {time}.",
  "rtp.failed": "Не нашёл безопасную точку, попробуй ещё раз через минуту.",
  "rtp.outside": "Точка за границей мира, попробуй снова.",
  "border.warn": "Граница мира близко: осталось {blocks} блоков",
  "border.push": "Граница мира сжалась — тебя вернуло внутрь",
  "border.blocked": "За границей мира строить нельзя",
  "border.info": "Радиус мира: {radius} блоков, неделя {week}",
  "lobby.safe": "Ты в безопасной зоне спавна. PvP и разрушение блоков отключены.",
  "lobby.leave": "Ты вышел из безопасной зоны — PvP включён.",
  "season.announce": "ВНИМАНИЕ: вайп сезона через {time}. Мир будет сброшен, сид изменён.",
  "season.final": "Сервер остановится для вайпа через {time}. Забери вещи из сундуков.",
  "season.armed": "Вайп взведён админом {actor}. Код подтверждения: {code}",
  "season.disarmed": "Вайп отменён",
  "season.status": "Сезон {index} начат {started}. До планового вайпа {left}.",
  "ac.alert": "[AC] {player}: {detector} +{weight}, скор {score} (порог {threshold})",
  "ac.clear": "[AC] скор {player} снижен до {score}",
  "ac.disabled": "детектор отключён",
  "audit.title": "Аудит (последние {count})",
  "admin.title": "Админ-панель",
  "admin.anticheat": "Античит: скоры игроков",
  "admin.config": "Настройки античита",
  "admin.audit": "Аудит-лог",
  "admin.sanctions": "Санкции (вручную)",
  "admin.season": "Сезон и вайп",
  "admin.border": "Граница мира",
  "admin.events": "Ивенты",
  "admin.eventStop": "Остановить активный ивент",
  "admin.modules": "Модули и задачи",
  "admin.auditEmpty": "Аудит пуст",
  "admin.noScores": "Подозрительных игроков нет",
  "admin.saved": "Настройки сохранены и применены",
  "admin.ban": "Забанить игрока",
  "admin.unban": "Снять бан",
  "admin.kick": "Кикнуть игрока",
  "admin.freeze": "Заморозить игрока",
  "admin.armed": "Вайп взведён. Для запуска выполни deploy/season-wipe.sh --confirm",
  "admin.disarm": "Отменить взведённый вайп",
  "admin.confirmCode": "Введи код подтверждения",
  "admin.badCode": "Код не совпал",
  "admin.noPermission": "Недостаточно прав",
  "admin.playerNotFound": "Игрок не найден",
  "admin.done": "Готово",
  "ban.kick": "Забанен: {reason}",
  "kick.reason": "Кикнут администратором: {reason}",
  "rules.text": "1. PvP разрешён везде, кроме лобби. 2. Гриф и воровство разрешены. 3. Читы, X-ray, авто-кликеры запрещены. 4. Дюп запрещён. 5. Оскорбления в чате — мут по решению админа. 6. Баги сообщать админам, а не использовать.",
  "stats.text": "Убийств: {kills} | Смертей: {deaths} | Время: {time} | Скор AC: {score}",
  "stats.mobile": "Платформа: мобильная",
  "common.yes": "Да",
  "common.no": "Нет",
  "common.back": "Назад",
  "common.seconds": "{n} с",
};

const en: Dict = {
  "menu.title": "Swipecraft — menu",
  "menu.body": "Anarchy: PvP everywhere except the lobby. Seasonal world, border shrinks weekly.",
  "menu.rtp": "Random teleport",
  "menu.rules": "World rules",
  "menu.stats": "My stats",
  "menu.lang": "Language / Язык",
  "menu.admin": "Admin panel",
  "menu.close": "Close",
  "rtp.ready": "Looking for a safe spot...",
  "rtp.done": "Teleported: {x} {y} {z}. Distance to border: {border} blocks.",
  "rtp.cooldown": "Teleport available in {time}.",
  "rtp.failed": "No safe spot found, try again in a minute.",
  "rtp.outside": "Spot is outside the world border, try again.",
  "border.warn": "World border nearby: {blocks} blocks left",
  "border.push": "The border moved in — you were pushed back",
  "border.blocked": "You cannot build outside the border",
  "border.info": "World radius: {radius} blocks, week {week}",
  "lobby.safe": "You are in the spawn safe zone. PvP and block breaking are disabled.",
  "lobby.leave": "You left the safe zone — PvP is on.",
  "season.announce": "WARNING: season wipe in {time}. The world will reset with a new seed.",
  "season.final": "Server stops for the wipe in {time}. Move your loot out of chests.",
  "season.armed": "Wipe armed by {actor}. Confirmation code: {code}",
  "season.disarmed": "Wipe cancelled",
  "season.status": "Season {index} started {started}. Planned wipe in {left}.",
  "ac.alert": "[AC] {player}: {detector} +{weight}, score {score} (threshold {threshold})",
  "ac.clear": "[AC] score of {player} dropped to {score}",
  "ac.disabled": "detector disabled",
  "audit.title": "Audit (last {count})",
  "admin.title": "Admin panel",
  "admin.anticheat": "Anticheat: player scores",
  "admin.config": "Anticheat settings",
  "admin.audit": "Audit log",
  "admin.sanctions": "Manual sanctions",
  "admin.season": "Season and wipe",
  "admin.border": "World border",
  "admin.events": "Events",
  "admin.eventStop": "Stop the active event",
  "admin.modules": "Modules and tasks",
  "admin.auditEmpty": "Audit is empty",
  "admin.noScores": "No suspicious players",
  "admin.saved": "Settings saved and applied",
  "admin.ban": "Ban player",
  "admin.unban": "Unban player",
  "admin.kick": "Kick player",
  "admin.freeze": "Freeze player",
  "admin.armed": "Wipe armed. Run deploy/season-wipe.sh --confirm to execute",
  "admin.disarm": "Cancel armed wipe",
  "admin.confirmCode": "Enter confirmation code",
  "admin.badCode": "Wrong code",
  "admin.noPermission": "Not enough permissions",
  "admin.playerNotFound": "Player not found",
  "admin.done": "Done",
  "ban.kick": "Banned: {reason}",
  "kick.reason": "Kicked by admin: {reason}",
  "rules.text": "1. PvP is allowed everywhere except the lobby. 2. Griefing and stealing are allowed. 3. Cheats, X-ray, autoclickers are forbidden. 4. Duping is forbidden. 5. Chat abuse leads to a manual mute. 6. Report bugs instead of abusing them.",
  "stats.text": "Kills: {kills} | Deaths: {deaths} | Time: {time} | AC score: {score}",
  "stats.mobile": "Platform: mobile",
  "common.yes": "Yes",
  "common.no": "No",
  "common.back": "Back",
  "common.seconds": "{n}s",
};

const dicts: Record<Lang, Dict> = { ru, en };
const extra: Record<Lang, Dict> = { ru: {}, en: {} };

export const addDict = (lang: Lang, dict: Dict): void => {
  Object.assign(extra[lang], dict);
};

const lookup = (lang: Lang, key: string): string => dicts[lang][key] ?? extra[lang][key] ?? dicts.ru[key] ?? extra.ru[key] ?? key;
const playerLangs = new Map<string, Lang>();

export const setLang = (playerId: string, lang: Lang): void => {
  playerLangs.set(playerId, lang);
};

export const getLang = (playerId: string): Lang => playerLangs.get(playerId) ?? "ru";

export const t = (player: Player | undefined, key: string, params?: Record<string, string | number>): string => {
  const lang = player ? getLang(player.id) : "ru";
  const template = lookup(lang, key);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`));
};

export const raw = (lang: Lang, key: string, params?: Record<string, string | number>): string => {
  const template = lookup(lang, key);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`));
};

export const translate = raw;
