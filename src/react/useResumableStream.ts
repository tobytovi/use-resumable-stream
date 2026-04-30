/**
 * useResumableStream：核心 Hook。
 *
 * 功能：
 * 1. 订阅指定 taskKey 的流状态（useSyncExternalStore）
 * 2. 提供 start / resume / cancel 操作
 * 3. 组件卸载时按 keepAliveOnUnmount 决定是否 abort 连接
 * 4. 支持多任务并行（通过 getTaskState 读取任意 key 的状态）
 *
 * 设计要点（来自项目踩坑）：
 * - 状态通过 useSyncExternalStore 订阅，不走 SWR cache（解决踩坑 #2）
 * - activeTaskKey 切换时立即从 store 读取新 key 的状态（解决踩坑 #3）
 * - keepAliveOnUnmount=true 时连接不随组件卸载而中止（解决踩坑 #1 #8）
 */
import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import type {
  StreamState,
  TaskKey,
  ResumableStreamOptions,
  ResumableStreamResult,
  PendingKey,
} from '../types';
import { createTaskRunner } from '../task-runner';
import { useStreamStore } from './StreamProvider';

/**
 * useResumableStream Hook。
 *
 * @param activeTaskKey 当前活跃的任务 key（可以是 pending 或 real）
 * @param options 配置选项
 *
 * @example
 * const { state, start, resume, cancel } = useResumableStream(activeWorkId, {
 *   startTransport: createSseTransport({ url: '/api/chat/start', parseMessage }),
 *   resumeTransport: createSseTransport({ url: '/api/chat/resume', parseMessage }),
 *   initialData: () => ({ content: '', status: 'idle' }),
 *   onEvent: (data, event) => {
 *     if (event.type === 'DELTA') return { ...data, content: data.content + event.delta };
 *     if (event.type === 'SNAPSHOT') {
 *       const snap = event.snapshot as string;
 *       return snap ? { ...data, content: snap } : data; // 空 snapshot 不覆盖
 *     }
 *     return data;
 *   },
 *   keepAliveOnUnmount: true,
 *   onCompleted: async (taskKey, realId) => {
 *     // 拉取落库内容、刷新列表等
 *   },
 * });
 */
export function useResumableStream<TData, TStartBody = unknown, TResumeBody = unknown>(
  activeTaskKey: TaskKey | null,
  options: ResumableStreamOptions<TData, TStartBody, TResumeBody>,
): ResumableStreamResult<TData, TStartBody> {
  const store = useStreamStore<TData>();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // TaskRunner 单例（与 store 绑定，不随 options 变化重建）
  const runnerRef = useRef<ReturnType<typeof createTaskRunner<TData, TStartBody, TResumeBody>> | null>(null);
  if (!runnerRef.current) {
    runnerRef.current = createTaskRunner<TData, TStartBody, TResumeBody>(store, options);
  }

  // 当前活跃 key（用于 useSyncExternalStore 订阅）
  const [currentKey, setCurrentKey] = useState<TaskKey | null>(activeTaskKey);

  // 同步 activeTaskKey 变化
  useEffect(() => {
    setCurrentKey(activeTaskKey);
  }, [activeTaskKey]);

  // 订阅当前 key 的状态（useSyncExternalStore 保证并发安全）
  const state = useSyncExternalStore<StreamState<TData>>(
    (listener) => {
      if (!currentKey) return () => {};
      return store.subscribe(currentKey, listener);
    },
    () => {
      if (!currentKey) {
        return {
          taskKey: 'pending-init' as PendingKey,
          status: 'idle' as const,
          data: options.initialData(),
          lastSeq: 0,
          updatedAt: Date.now(),
        };
      }
      return (
        store.getState(currentKey) ?? {
          taskKey: currentKey,
          status: 'idle' as const,
          data: options.initialData(),
          lastSeq: 0,
          updatedAt: Date.now(),
        }
      );
    },
    // 服务端快照（SSR 兼容）
    () => ({
      taskKey: (currentKey ?? 'pending-ssr') as TaskKey,
      status: 'idle' as const,
      data: options.initialData(),
      lastSeq: 0,
      updatedAt: 0,
    }),
  );

  // 组件卸载时处理连接
  useEffect(() => () => {
    if (!optionsRef.current.keepAliveOnUnmount && currentKey) {
      runnerRef.current?.cancel(currentKey);
    }
  }, [currentKey]);

  // ─────────────────────────────────────────────
  // 公开 API
  // ─────────────────────────────────────────────

  function start(body: TStartBody): { pendingKey: PendingKey; realId: Promise<string> } {
    const runner = runnerRef.current!;
    const result = runner.start(body);
    // 立即切换到 pendingKey，让 UI 立即响应
    setCurrentKey(result.pendingKey);
    // realId resolve 后自动切换到真实 key
    result.realId.then((realId) => {
      setCurrentKey(realId as TaskKey);
    }).catch(() => {});
    return result as { pendingKey: PendingKey; realId: Promise<string> };
  }

  function resume(taskKey: TaskKey, fromSeq?: number) {
    runnerRef.current?.resume(taskKey, fromSeq);
  }

  function cancel() {
    if (currentKey) {
      runnerRef.current?.cancel(currentKey);
    }
  }

  function getTaskState(taskKey: TaskKey): StreamState<TData> | undefined {
    return store.getState(taskKey);
  }

  return { state, start, resume, cancel, getTaskState };
}
