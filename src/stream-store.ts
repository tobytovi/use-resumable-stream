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

  /**
   * 解析别名（支持链式）：如果 key 有别名，递归追溯到最终 key。
   *
   * 链式语义示例：A → B → C，则 resolveKey(A) === resolveKey(B) === C。
   * 防御无限环：使用 Set 记录已访问 key。
   */
  function resolveKey(key: TaskKey): TaskKey {
    let current = key;
    const visited = new Set<TaskKey>();
    while (aliasMap.has(current) && !visited.has(current)) {
      visited.add(current);
      current = aliasMap.get(current)!;
    }
    return current;
  }

  /** 收集所有最终解析到 finalKey 的源别名（含 finalKey 自身），用于通知链上每一环 */
  function collectAliasChain(finalKey: TaskKey): Set<TaskKey> {
    const chain = new Set<TaskKey>([finalKey]);
    // 反向遍历 aliasMap：如果某个 src 解析后等于 finalKey，则纳入
    let changed = true;
    while (changed) {
      changed = false;
      aliasMap.forEach((dest, src) => {
        if (chain.has(dest) && !chain.has(src)) {
          chain.add(src);
          changed = true;
        }
      });
    }
    return chain;
  }

  /** 读取状态（自动解析别名） */
  function getState(key: TaskKey): StreamState<T> | undefined {
    const resolved = resolveKey(key);
    return stateMap.get(resolved);
  }

  /** 写入状态并通知所有沿别名链解析到此 key 的订阅者 */
  function setState(key: TaskKey, state: StreamState<T>) {
    const resolved = resolveKey(key);
    stateMap.set(resolved, state);
    // 通知整条别名链上的所有订阅者（含 resolved 自身和所有最终指向它的别名 key）
    const chain = collectAliasChain(resolved);
    chain.forEach(notify);
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
