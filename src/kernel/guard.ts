import { describeError, log } from "./logger";

interface BreakerState {
  failures: number;
  disabled: boolean;
  lastError: string;
}

const breakers = new Map<string, BreakerState>();
const FAILURE_LIMIT = 5;

const state = (scope: string): BreakerState => {
  const existing = breakers.get(scope);
  if (existing) return existing;
  const created: BreakerState = { failures: 0, disabled: false, lastError: "" };
  breakers.set(scope, created);
  return created;
};

export const isDisabled = (scope: string): boolean => state(scope).disabled;

export const safeRun = <T>(scope: string, fn: () => T): T | undefined => {
  const current = state(scope);
  if (current.disabled) return undefined;
  try {
    const result = fn();
    current.failures = 0;
    return result;
  } catch (error) {
    current.failures += 1;
    current.lastError = describeError(error);
    if (current.failures >= FAILURE_LIMIT) {
      current.disabled = true;
      log.error(scope, `модуль отключён после ${FAILURE_LIMIT} ошибок: ${current.lastError}`);
    } else {
      log.error(scope, current.lastError);
    }
    return undefined;
  }
};

export const safeRunAsync = async <T>(scope: string, fn: () => Promise<T>): Promise<T | undefined> => {
  const current = state(scope);
  if (current.disabled) return undefined;
  try {
    const result = await fn();
    current.failures = 0;
    return result;
  } catch (error) {
    current.failures += 1;
    current.lastError = describeError(error);
    if (current.failures >= FAILURE_LIMIT) {
      current.disabled = true;
      log.error(scope, `модуль отключён после ${FAILURE_LIMIT} ошибок: ${current.lastError}`);
    } else {
      log.error(scope, current.lastError);
    }
    return undefined;
  }
};

export const breakerReport = (): string[] =>
  [...breakers.entries()]
    .filter(([, value]) => value.failures > 0 || value.disabled)
    .map(([scope, value]) => `${scope}: failures=${value.failures} disabled=${value.disabled} ${value.lastError}`);
