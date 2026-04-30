/**
 * AutoResumeList：自动续订列表组件。
 *
 * 用于首页/列表页：扫描任务列表，对所有"生成中"的任务自动发起续订。
 * 这是解决"刷新页面后进行中的任务不续订"问题的关键组件。
 *
 * 设计要点（来自项目踩坑）：
 * - 只对真实 key（非 pending）发起续订（解决踩坑 #5）
 * - 已达终态的任务不续订（解决踩坑 #4）
 * - 组件卸载时不取消连接（keepAlive 语义）
 * - 同一 key 不建立第二条连接（TaskRunner 内部去重）
 */
import { useEffect, useRef } from 'react';
import type { Transport, ResumableStreamOptions, TaskKey } from '../types';
import { createTaskRunner } from '../task-runner';
import { useStreamStore } from './StreamProvider';
import { isRealKey } from '../task-key';

export interface AutoResumeListProps<TData, TResumeBody = unknown> {
  /**
   * 需要续订的任务 key 列表。
   * 通常来自后端返回的"生成中"任务列表。
   * 只有 isRealKey(key) === true 的 key 才会发起续订。
   */
  taskKeys: string[];

  /**
   * 续订用的 Transport。
   */
  resumeTransport: Transport<TResumeBody>;

  /**
   * 初始数据工厂（与 useResumableStream 保持一致）。
   */
  initialData: () => TData;

  /**
   * 事件 reducer（与 useResumableStream 保持一致）。
   */
  onEvent: ResumableStreamOptions<TData>['onEvent'];

  /**
   * 任务完成回调。
   */
  onCompleted?: ResumableStreamOptions<TData>['onCompleted'];

  /**
   * 任务失败回调。
   */
  onFailed?: ResumableStreamOptions<TData>['onFailed'];

  /**
   * 重连延迟配置。
   */
  retryDelays?: readonly number[];
}

/**
 * AutoResumeList 组件。
 * 渲染为 null（纯逻辑组件），挂载时自动对 taskKeys 中的任务发起续订。
 *
 * @example
 * // 在列表页挂载，自动续订所有生成中的任务
 * <AutoResumeList
 *   taskKeys={workList
 *     .filter(w => w.status === 'GENERATING')
 *     .map(w => String(w.work_id))}
 *   resumeTransport={resumeTransport}
 *   initialData={() => ({ content: '', status: 'idle' })}
 *   onEvent={chatEventReducer}
 *   onCompleted={async (taskKey, realId) => {
 *     await refetchWorkList();
 *   }}
 * />
 */
export function AutoResumeList<TData, TResumeBody = unknown>({
  taskKeys,
  resumeTransport,
  initialData,
  onEvent,
  onCompleted,
  onFailed,
  retryDelays,
}: AutoResumeListProps<TData, TResumeBody>) {
  const store = useStreamStore<TData>();

  // 用 ref 保存 runner，避免 taskKeys 变化时重建
  const runnerRef = useRef<ReturnType<typeof createTaskRunner<TData, unknown, TResumeBody>> | null>(null);

  if (!runnerRef.current) {
    runnerRef.current = createTaskRunner<TData, unknown, TResumeBody>(store, {
      resumeTransport,
      initialData,
      onEvent,
      ...(onCompleted !== undefined && { onCompleted }),
      ...(onFailed !== undefined && { onFailed }),
      ...(retryDelays !== undefined && { retryDelays }),
      keepAliveOnUnmount: true,
    });
  }

  // 当 taskKeys 变化时，对新增的 key 发起续订
  const resumedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const runner = runnerRef.current!;

    for (const key of taskKeys) {
      // 只对真实 key 续订
      if (!isRealKey(key as TaskKey)) continue;
      // 已经续订过的不重复
      if (resumedKeysRef.current.has(key)) continue;

      resumedKeysRef.current.add(key);
      runner.resume(key as TaskKey);
    }
  }, [taskKeys]);

  // 组件卸载时清理已续订记录（但不取消连接）
  useEffect(() => () => {
    resumedKeysRef.current.clear();
  }, []);

  return null;
}
