type Level = "debug" | "info" | "warn" | "error";

const RING_LIMIT = 200;
const ring: string[] = [];

const stamp = (): string => new Date().toISOString().slice(11, 19);

const push = (line: string): void => {
  ring.push(line);
  if (ring.length > RING_LIMIT) ring.shift();
};

const emit = (level: Level, scope: string, message: string): void => {
  const line = `[${stamp()}][${level}][${scope}] ${message}`;
  push(line);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const log = {
  debug: (scope: string, message: string): void => emit("debug", scope, message),
  info: (scope: string, message: string): void => emit("info", scope, message),
  warn: (scope: string, message: string): void => emit("warn", scope, message),
  error: (scope: string, message: string): void => emit("error", scope, message),
  tail: (count: number): string[] => ring.slice(-count),
  dump: (): string => ring.join("\n"),
};

export const describeError = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
};
