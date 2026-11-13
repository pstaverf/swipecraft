import { Player, Vector3 } from "@minecraft/server";

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const distance2d = (a: Vector3, b: Vector3): number => Math.hypot(a.x - b.x, a.z - b.z);

export const distance3d = (a: Vector3, b: Vector3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const randomInt = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));

export const randomPointInRing = (minRadius: number, maxRadius: number): { x: number; z: number } => {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * (maxRadius - minRadius) + minRadius;
  return { x: Math.round(Math.cos(angle) * radius), z: Math.round(Math.sin(angle) * radius) };
};

export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}д ${hours}ч`;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
};

export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const shortId = (id: string): string => id.slice(0, 8);

export const isMobile = (player: Player): boolean => {
  try {
    return player.clientSystemInfo.platformType === "Mobile";
  } catch {
    return false;
  }
};

export const chunkKey = (x: number, z: number): string => `${Math.floor(x / 16)}:${Math.floor(z / 16)}`;

export const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export const stdDev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

export const horizontalSpeed = (from: Vector3, to: Vector3, ticks: number): number => {
  if (ticks <= 0) return 0;
  return (Math.hypot(to.x - from.x, to.z - from.z) * 20) / ticks;
};
