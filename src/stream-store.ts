/**
 * StreamStore：应用级单例状态存储。
 *
 * 设计要点（来自项目踩坑）：
 * 1. 单例 Map，不依赖 React 组件生命周期（解决踩坑 #1 #8）
 * 2. 基于 useSyncExternalStore 的订阅模式，精确触发 rerender
 * 3. pendingKey → realKey 的别名映射，支持 key 迁移（解决踩坑 #5）
 * 4. 不在组件卸载时清除状态，保留 lastSeq 供下次续订
 */
import type { StreamState, TaskKey } from './types';

type Listener = () => void;

/**
 * 创建一个独立的 StreamStore 实例。
 * 通常通过 StreamProvider 在应用级创建单例。
 */
export function createStreamStore<T>() {
  // 主状态 Map：taskKey → StreamState
  const stateMap = new Map<TaskKey, StreamState<T>>();

  // 别名 Map：pendingKey → realKey（key 迁移后建立映射）
  const aliasMap = new Map<TaskKey, TaskKey>();

  // 订阅者 Map：taskKey → Set<Listener>
  const listenersMap = new Map<TaskKey, Set<Listener>>();

  // 全局订阅者（任意 key 变化都触发）
  const globalListeners = new Set<Listener>();

  /** 通知指定 key 的所有订阅者 */
  function notify(key: TaskKey) {
    listenersMap.get(key)?.forEach(fn => fn());
    globalListeners.forEach(fn => fn());
  }

  /** 解析别名：如果 key 有别名，返回真实 key */
  function resolveKey(key: TaskKey): TaskKey {
    return aliasMap.get(key) ?? key;
  }

  /** 读取状态（自动解析别名） */
  function getState(key: TaskKey): StreamState<T> | undefined {
    const resolved = resolveKey(key);
    return stateMap.get(resolved);
  }

  /** 写入状态并通知订阅者 */
  function setState(key: TaskKey, state: StreamState<T>) {
    const resolved = resolveKey(key);
    stateMap.set(resolved, state);
    notify(resolved);
    // 如果有别名指向此 key，也通知别名的订阅者
    aliasMap.forEach((realKey, pendingKey) => {
      if (realKey === resolved) {
        notify(pendingKey);
      }
    });
  }

  /**
   * 建立 pendingKey → realKey 的别名映射。
   * 迁移后，对 pendingKey 的读取会自动转发到 realKey。
   */
  function migrateKey(pendingKey: TaskKey, realKey: TaskKey) {
    aliasMap.set(pendingKey, realKey);
    // 通知 pendingKey 的订阅者（让 view 层感知到迁移）
    notify(pendingKey);
  }

  /** 删除状态（GC 用，通常不需要手动调用） */
  function deleteState(key: TaskKey) {
    const resolved = resolveKey(key);
    stateMap.delete(resolved);
    notify(resolved);
  }

  /** 订阅指定 key 的状态变化（供 useSyncExternalStore 使用） */
  function subscribe(key: TaskKey, listener: Listener): () => void {
    const resolved = resolveKey(key);
    if (!listenersMap.has(resolved)) {
      listenersMap.set(resolved, new Set());
    }
    listenersMap.get(resolved)!.add(listener);

    // 如果 key 是 pendingKey，也订阅它自身（迁移通知用）
    if (key !== resolved) {
      if (!listenersMap.has(key)) {
        listenersMap.set(key, new Set());
      }
      listenersMap.get(key)!.add(listener);
    }

    return () => {
      listenersMap.get(resolved)?.delete(listener);
      if (key !== resolved) {
        listenersMap.get(key)?.delete(listener);
      }
    };
  }

  /** 订阅所有 key 的变化（供 DevTools / AutoResumeList 使用） */
  function subscribeAll(listener: Listener): () => void {
    globalListeners.add(listener);
    return () => globalListeners.delete(listener);
  }

  /** 获取所有活跃任务的 key 列表 */
  function getAllKeys(): TaskKey[] {
    return Array.from(stateMap.keys());
  }

  /** 获取所有状态快照（供 DevTools 使用） */
  function getSnapshot(): Map<TaskKey, StreamState<T>> {
    return new Map(stateMap);
  }

  return {
    getState,
    setState,
    migrateKey,
    deleteState,
    subscribe,
    subscribeAll,
    getAllKeys,
    getSnapshot,
    resolveKey,
  };
}

export type StreamStore<T> = ReturnType<typeof createStreamStore<T>>;
