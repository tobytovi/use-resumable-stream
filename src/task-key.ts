/**
 * TaskKey 工具函数。
 *
 * 核心设计：区分"占位 key"和"真实 key"，
 * 避免把 pending-xxx 当作真实 ID 发给后端（踩坑 #5）。
 */
import type { PendingKey, RealKey, TaskKey } from './types';

/** 生成一个唯一的占位 key */
export function createPendingKey(): PendingKey {
  const rand = Math.random().toString(36).slice(2, 9);
  return `pending-${rand}-${Date.now()}` as PendingKey;
}

/** 将字符串强制转换为 RealKey（仅在确认是真实 ID 时使用） */
export function toRealKey(id: string): RealKey {
  return id as RealKey;
}

/** 判断是否为占位 key */
export function isPendingKey(key: TaskKey): key is PendingKey {
  return key.startsWith('pending-');
}

/** 判断是否为真实 key */
export function isRealKey(key: TaskKey): key is RealKey {
  return !key.startsWith('pending-');
}

/**
 * 从 key 中提取可安全发给后端的 ID。
 * 如果是占位 key，返回 null（调用方不应发起网络请求）。
 */
export function extractRealId(key: TaskKey): string | null {
  if (isPendingKey(key)) return null;
  return key;
}
