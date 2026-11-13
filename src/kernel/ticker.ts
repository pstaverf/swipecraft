import { system } from "@minecraft/server";
import { safeRun } from "./guard";
import { log } from "./logger";

interface Task {
  name: string;
  interval: number;
  budgetMs: number;
  fn: () => void;
  nextRun: number;
  slow: number;
  disabled: boolean;
}

const tasks: Task[] = [];
let running = false;
let intervalId: number | undefined;
let ticks = 0;

const now = (): number => Date.now();

export const registerTask = (name: string, intervalTicks: number, budgetMs: number, fn: () => void): void => {
  if (tasks.some((task) => task.name === name)) {
    log.warn("ticker", `задача ${name} уже зарегистрирована`);
    return;
  }
  tasks.push({
    name,
    interval: Math.max(1, Math.floor(intervalTicks)),
    budgetMs,
    fn,
    nextRun: ticks + 1,
    slow: 0,
    disabled: false,
  });
};

const runTasks = (): void => {
  ticks += 1;
  for (const task of tasks) {
    if (task.disabled || ticks < task.nextRun) continue;
    const started = now();
    safeRun(`ticker:${task.name}`, task.fn);
    const spent = now() - started;
    if (spent > task.budgetMs) {
      task.slow += 1;
      if (task.slow >= 3 && task.interval < 200) {
        task.interval *= 2;
        task.slow = 0;
        log.warn("ticker", `задача ${task.name} тормозит (${spent}мс), интервал увеличен до ${task.interval} тиков`);
      }
    } else if (task.slow > 0) {
      task.slow -= 1;
    }
    task.nextRun = ticks + task.interval;
  }
};

export const startTicker = (): void => {
  if (running) return;
  running = true;
  intervalId = system.runInterval(runTasks, 1);
  log.info("ticker", `запущен, задач: ${tasks.length}`);
};

export const stopTicker = (): void => {
  if (intervalId !== undefined) system.clearRun(intervalId);
  intervalId = undefined;
  running = false;
};

export const disableTask = (name: string): boolean => {
  const task = tasks.find((item) => item.name === name);
  if (!task) return false;
  task.disabled = true;
  return true;
};

export const enableTask = (name: string): boolean => {
  const task = tasks.find((item) => item.name === name);
  if (!task) return false;
  task.disabled = false;
  task.nextRun = ticks + 1;
  return true;
};

export const tickerReport = (): string[] =>
  tasks.map(
    (task) =>
      `${task.name}: interval=${task.interval} ${task.disabled ? "disabled" : "active"}${task.slow > 0 ? ` slow=${task.slow}` : ""}`,
  );

export const currentTick = (): number => ticks;
