/**
 * TaskRunner：任务执行引擎。
 *
 * 职责：
 * 1. 管理单个任务的 SSE 连接生命周期
 * 2. 指数退避重连（断线后自动续订）
 * 3. pendingKey → realKey 迁移
 * 4. 状态写入 StreamStore
 * 5. 连接去重（同一 taskKey 不建立第二条连接）
 *
 * 设计要点（来自项目踩坑）：
 * - 连接不依赖 React 组件生命周期（解决踩坑 #1 #8）
 * - 已达终态（completed/failed）的任务不发起 resume（解决踩坑 #4）
 * - 占位 key 不发网络请求（解决踩坑 #5）
 * - 空 SNAPSHOT 不覆盖已有内容（由 onEvent 回调的 reducer 保证，解决踩坑 #4）
 */
import type {
  StreamState,
  StreamEvent,
  Transport,
  TaskKey,
  ResumableStreamOptions,
} from './types';
import { createPendingKey, isPendingKey, toRealKey } from './task-key';
import type { StreamStore } from './stream-store';

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000] as const;

/** 单个任务的运行上下文 */
interface TaskContext {
  abortController: AbortController;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  closed: boolean;
  /** 真实 ID（META 事件到达后设置） */
  realId: string | null;
  /** resolve realId 的 Promise */
  resolveRealId: ((id: string) => void) | null;
}

/**
 * 创建 TaskRunner。
 * 每个 useResumableStream 实例持有一个 TaskRunner。
 */
export function createTaskRunner<TData, TStartBody = unknown, TResumeBody = unknown>(
  store: StreamStore<TData>,
  options: ResumableStreamOptions<TData, TStartBody, TResumeBody>,
) {
  const {
    startTransport,
    resumeTransport,
    initialData,
    onEvent,
    keepAliveOnUnmount = true,
    retryDelays = DEFAULT_RETRY_DELAYS,
    onCompleted,
    onFailed,
  } = options;

  // 活跃任务 Map：taskKey → TaskContext
  const activeContexts = new Map<TaskKey, TaskContext>();

  /** 读取 store 状态，若无则创建初始态 */
  function readOrCreate(taskKey: TaskKey): StreamState<TData> {
    return store.getState(taskKey) ?? {
      taskKey,
      status: 'idle',
      data: initialData(),
      lastSeq: 0,
      updatedAt: Date.now(),
    };
  }

  /** 写入状态到 store */
  function writeState(taskKey: TaskKey, patch: Partial<StreamState<TData>>) {
    const current = readOrCreate(taskKey);
    store.setState(taskKey, { ...current, ...patch, updatedAt: Date.now() });
  }

  /**
   * 发起新任务（start）。
   * 立即返回 pendingKey，Promise resolve 时返回真实 ID。
   */
  function start(body: TStartBody): { pendingKey: TaskKey; realId: Promise<string> } {
    if (!startTransport) {
      throw new Error('[use-resumable-stream] startTransport 未配置，无法发起新任务');
    }

    const pendingKey = createPendingKey();
    let resolveRealId!: (id: string) => void;
    const realIdPromise = new Promise<string>((resolve) => {
      resolveRealId = resolve;
    });

    // 初始化占位状态
    writeState(pendingKey, {
      taskKey: pendingKey,
      status: 'connecting',
      data: initialData(),
      lastSeq: 0,
    });

    const ctx: TaskContext = {
      abortController: new AbortController(),
      retryTimer: null,
      attempt: 0,
      closed: false,
      realId: null,
      resolveRealId,
    };
    activeContexts.set(pendingKey, ctx);

    void runStart(pendingKey, body, ctx, startTransport);

    return { pendingKey, realId: realIdPromise };
  }

  /**
   * 续订已有任务（resume）。
   * 从 store 中读取 lastSeq，发起续订请求。
   */
  function resume(taskKey: TaskKey, fromSeq?: number) {
    if (!resumeTransport) {
      console.warn('[use-resumable-stream] resumeTransport 未配置，无法续订任务');
      return;
    }

    // 占位 key 不发网络请求（解决踩坑 #5）
    if (isPendingKey(taskKey)) {
      return;
    }

    const current = readOrCreate(taskKey);

    // 已达终态不续订（解决踩坑 #4）
    if (current.status === 'completed' || current.status === 'failed') {
      return;
    }

    // 已有活跃连接不重复建立
    const existing = activeContexts.get(taskKey);
    if (existing && !existing.closed) {
      return;
    }

    const ctx: TaskContext = {
      abortController: new AbortController(),
      retryTimer: null,
      attempt: 0,
      closed: false,
      realId: taskKey,
      resolveRealId: null,
    };
    activeContexts.set(taskKey, ctx);

    const seq = fromSeq ?? current.lastSeq;
    void runResume(taskKey, seq, ctx, resumeTransport as Transport<unknown>);
  }

  /** 取消指定任务的连接 */
  function cancel(taskKey: TaskKey) {
    const ctx = activeContexts.get(taskKey);
    if (!ctx) return;
    ctx.closed = true;
    if (ctx.retryTimer) {
      clearTimeout(ctx.retryTimer);
      ctx.retryTimer = null;
    }
    ctx.abortController.abort();
    activeContexts.delete(taskKey);
  }

  /** 取消所有活跃连接（组件卸载时，keepAliveOnUnmount=false 时调用） */
  function cancelAll() {
    activeContexts.forEach((_, key) => cancel(key));
  }

  // ─────────────────────────────────────────────
  // 内部：运行 start 流
  // ─────────────────────────────────────────────

  async function runStart(
    pendingKey: TaskKey,
    body: TStartBody,
    ctx: TaskContext,
    transport: Transport<TStartBody>,
  ) {
    let currentData = initialData();
    let realKey: TaskKey | null = null;

    await transport.connect(
      { ...body, resumeFromSeq: 0 } as TStartBody & { resumeFromSeq?: number },
      {
        signal: ctx.abortController.signal,
        onEvent: (event: StreamEvent) => {
          // META 事件：迁移 pendingKey → realKey
          if (event.type === 'META' && event.realId && !realKey) {
            realKey = toRealKey(event.realId);
            ctx.realId = event.realId;

            // 建立别名映射
            store.migrateKey(pendingKey, realKey);

            // 初始化 realKey 的状态
            writeState(realKey, {
              taskKey: realKey,
              status: 'streaming',
              data: currentData,
              lastSeq: event.seq,
            });

            // resolve realId Promise
            ctx.resolveRealId?.(event.realId);
          }

          // 更新业务数据
          currentData = onEvent(currentData, event);

          // 写入状态
          const targetKey = realKey ?? pendingKey;
          const current = readOrCreate(targetKey);
          const nextStatus = getNextStatus(current.status, event);
          const patch1: Partial<StreamState<TData>> = {
            data: currentData,
            status: nextStatus,
            lastSeq: event.type !== 'HEARTBEAT'
              ? Math.max(current.lastSeq, event.seq)
              : current.lastSeq,
          };
          if (event.type === 'ERROR') patch1.errorMessage = event.message;
          else if (current.errorMessage) patch1.errorMessage = current.errorMessage;
          writeState(targetKey, patch1);

          // STOP 事件：触发 onCompleted 回调
          if (event.type === 'STOP') {
            const finalRealId = realKey ?? undefined;
            void onCompleted?.(targetKey, finalRealId?.toString());
          }

          // ERROR 事件：触发 onFailed 回调
          if (event.type === 'ERROR') {
            onFailed?.(targetKey, event.message);
          }
        },
        onError: (message: string) => {
          const targetKey = realKey ?? pendingKey;
          writeState(targetKey, { status: 'failed', errorMessage: message });
          onFailed?.(targetKey, message);
        },
        onDone: () => {
          // 连接正常关闭，状态由 STOP/ERROR 事件处理
        },
      },
    );

    if (!ctx.closed) {
      activeContexts.delete(pendingKey);
      if (realKey) activeContexts.delete(realKey);
    }
  }

  // ─────────────────────────────────────────────
  // 内部：运行 resume 流（带指数退避重连）
  // ─────────────────────────────────────────────

  async function runResume(
    taskKey: TaskKey,
    fromSeq: number,
    ctx: TaskContext,
    transport: Transport<unknown>,
  ) {
    const current = readOrCreate(taskKey);
    if (current.status !== 'streaming') {
      writeState(taskKey, { status: 'connecting' });
    }

    let naturalStop = false;
    let hardError: string | null = null;
    let currentData = current.data;

    await transport.connect(
      { resumeFromSeq: fromSeq } as unknown & { resumeFromSeq?: number },
      {
        signal: ctx.abortController.signal,
        onEvent: (event: StreamEvent) => {
          currentData = onEvent(currentData, event);
          const latest = readOrCreate(taskKey);
          const nextStatus = getNextStatus(latest.status, event);
          const patch2: Partial<StreamState<TData>> = {
            data: currentData,
            status: nextStatus,
            lastSeq: event.type !== 'HEARTBEAT'
              ? Math.max(latest.lastSeq, event.seq)
              : latest.lastSeq,
          };
          if (event.type === 'ERROR') patch2.errorMessage = event.message;
          else if (latest.errorMessage) patch2.errorMessage = latest.errorMessage;
          writeState(taskKey, patch2);

          if (event.type === 'STOP') {
            naturalStop = true;
            void onCompleted?.(taskKey, ctx.realId ?? undefined);
          }
          if (event.type === 'ERROR') {
            naturalStop = true;
            onFailed?.(taskKey, event.message);
          }
        },
        onError: (message: string) => {
          hardError = message;
        },
        onDone: () => {},
      },
    );

    if (ctx.closed) return;
    if (naturalStop) {
      activeContexts.delete(taskKey);
      return;
    }

    // 网络异常：检查是否需要重连
    const latest = readOrCreate(taskKey);
    if (latest.status === 'completed') {
      activeContexts.delete(taskKey);
      return;
    }

    if (ctx.attempt >= retryDelays.length) {
      writeState(taskKey, {
        status: 'failed',
        errorMessage: hardError ?? '连接已断开，重连次数耗尽',
      });
      onFailed?.(taskKey, hardError ?? '连接已断开');
      activeContexts.delete(taskKey);
      return;
    }

    const delay = retryDelays[ctx.attempt];
    ctx.attempt += 1;

    ctx.retryTimer = setTimeout(() => {
      if (!ctx.closed) {
        const refreshed = readOrCreate(taskKey);
        void runResume(taskKey, refreshed.lastSeq, ctx, transport);
      }
    }, delay);
  }

  // ─────────────────────────────────────────────
  // 工具函数
  // ─────────────────────────────────────────────

  /** 根据事件类型推导下一个状态 */
  function getNextStatus(
    current: StreamState<TData>['status'],
    event: StreamEvent,
  ): StreamState<TData>['status'] {
    if (current === 'failed') return 'failed'; // 已失败不回退
    switch (event.type) {
      case 'META':
      case 'DELTA':
      case 'SNAPSHOT':
      case 'USAGE' as StreamEvent['type']:
        return 'streaming';
      case 'STOP':
        return 'completed';
      case 'ERROR':
        return 'failed';
      case 'HEARTBEAT':
        return current;
      default:
        return current;
    }
  }

  return { start, resume, cancel, cancelAll };
}

export type TaskRunner<TData, TStartBody = unknown> = ReturnType<
  typeof createTaskRunner<TData, TStartBody>
>;
