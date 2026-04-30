/**
 * use-resumable-stream — 核心类型定义
 *
 * 设计原则（来自项目实战踩坑）：
 * 1. TaskKey 区分 pending（占位）和 real（真实 ID），避免字符串混用
 * 2. StreamState 包含 lastSeq，支持断线续传
 * 3. StreamEvent 穷尽联合类型，reducer 必须处理所有分支
 * 4. Transport 接口与具体实现解耦（SSE / WebSocket / HTTP polling 均可接入）
 * 5. onEvent 防御性语义：空 SNAPSHOT 不覆盖已有内容（踩坑 #4）
 */

// ─────────────────────────────────────────────
// Task Key 类型（区分占位 key 和真实 ID）
// ─────────────────────────────────────────────

/** 占位 key：任务发起后、服务端返回真实 ID 前使用 */
export type PendingKey = `pending-${string}`;

/** 真实 key：服务端分配的任务 ID（字符串形式） */
export type RealKey = string & { readonly __brand: 'RealKey' };

/** 任务 key 联合类型 */
export type TaskKey = PendingKey | RealKey;

// ─────────────────────────────────────────────
// 流状态
// ─────────────────────────────────────────────

/** 任务的生命周期状态 */
export type StreamStatus =
  | 'idle'        // 初始态，未发起
  | 'connecting'  // 连接建立中
  | 'streaming'   // 正在接收数据
  | 'completed'   // 自然结束（STOP 事件）
  | 'failed';     // 错误终止（ERROR 事件 或 重连耗尽）

/** 流状态快照（泛型 T 为业务数据类型） */
export interface StreamState<T = unknown> {
  /** 当前任务 key（可能是 pending 或 real） */
  taskKey: TaskKey;
  /** 生命周期状态 */
  status: StreamStatus;
  /** 业务数据（由 onEvent reducer 累积） */
  data: T;
  /** 最后收到的事件序号，用于断线续传 */
  lastSeq: number;
  /** 错误信息（status === 'failed' 时有值） */
  errorMessage?: string;
  /** 最后更新时间戳 */
  updatedAt: number;
}

// ─────────────────────────────────────────────
// 流事件（归一化后的内部事件类型）
// ─────────────────────────────────────────────

/**
 * 归一化事件：所有 Transport 的原始消息都必须转换为此格式。
 *
 * - META：任务元信息（服务端分配的真实 ID、初始 seq）
 * - DELTA：增量数据（追加语义）
 * - SNAPSHOT：全量快照（覆盖语义，但空值不覆盖）
 * - STOP：任务自然结束
 * - ERROR：业务错误
 * - HEARTBEAT：心跳（不推进 seq，不改变数据）
 */
export type StreamEvent<TDelta = unknown, TSnapshot = unknown> =
  | { type: 'META'; realId: string; seq: number }
  | { type: 'DELTA'; delta: TDelta; seq: number }
  | { type: 'SNAPSHOT'; snapshot: TSnapshot; seq: number }
  | { type: 'STOP'; realId?: string; seq: number }
  | { type: 'ERROR'; message: string; seq: number }
  | { type: 'HEARTBEAT' };

// ─────────────────────────────────────────────
// Transport 接口（可插拔传输层）
// ─────────────────────────────────────────────

/** Transport 连接选项 */
export interface TransportConnectOptions {
  /** AbortSignal，用于取消连接 */
  signal: AbortSignal;
  /** 收到原始消息时的回调（Transport 负责解析为 StreamEvent） */
  onEvent: (event: StreamEvent) => void;
  /** 连接发生错误时的回调 */
  onError: (message: string) => void;
  /** 连接正常关闭时的回调 */
  onDone: () => void;
}

/** Transport 接口：所有传输实现必须满足此接口 */
export interface Transport<TBody = unknown> {
  /**
   * 建立连接并开始接收事件。
   * @param body 请求体（包含 resumeFromSeq 等续传参数）
   * @param options 连接选项
   * @returns Promise，连接关闭后 resolve
   */
  connect(
    body: TBody & { resumeFromSeq?: number },
    options: TransportConnectOptions,
  ): Promise<void>;
}

// ─────────────────────────────────────────────
// useResumableStream Hook 配置
// ─────────────────────────────────────────────

/**
 * useResumableStream 的配置选项。
 *
 * TData：业务数据类型（由 onEvent 累积）
 * TStartBody：发起任务的请求体类型
 * TResumeBody：续订任务的请求体类型
 */
export interface ResumableStreamOptions<
  TData,
  TStartBody = unknown,
  TResumeBody = unknown,
> {
  /**
   * 发起新任务的 Transport（POST /start）。
   * 如果不提供，则只能 resume 已有任务。
   */
  startTransport?: Transport<TStartBody>;

  /**
   * 续订已有任务的 Transport（POST /resume）。
   * 如果不提供，则断线后不会自动重连。
   */
  resumeTransport?: Transport<TResumeBody>;

  /**
   * 初始数据工厂函数。
   * 每次 start() 时调用，返回 TData 的初始值。
   */
  initialData: () => TData;

  /**
   * 事件归一化 + 状态 reducer（合二为一）。
   *
   * 接收当前状态和一条 StreamEvent，返回新状态。
   * 这是整个库最核心的扩展点：
   * - DELTA 事件：追加语义（content += delta）
   * - SNAPSHOT 事件：覆盖语义（但空值不覆盖，防御踩坑 #4）
   * - 其他事件：按需处理
   *
   * @example
   * onEvent: (state, event) => {
   *   if (event.type === 'DELTA') {
   *     return { ...state, content: state.content + (event.delta as string) };
   *   }
   *   if (event.type === 'SNAPSHOT') {
   *     const snap = event.snapshot as string;
   *     return snap ? { ...state, content: snap } : state; // 空 snapshot 不覆盖
   *   }
   *   return state;
   * }
   */
  onEvent: (state: TData, event: StreamEvent) => TData;

  /**
   * 组件卸载时是否保持连接活跃。
   * - true（默认）：连接由 STOP/ERROR 自然终止，切走再切回不丢进度
   * - false：组件卸载时 abort 连接
   */
  keepAliveOnUnmount?: boolean;

  /**
   * 指数退避重连配置。
   * 默认：[1000, 2000, 4000]（ms），最多重连 3 次。
   */
  retryDelays?: readonly number[];

  /**
   * 任务完成后的回调（STOP 事件触发）。
   * 可在此处拉取落库内容、刷新列表等。
   */
  onCompleted?: (taskKey: TaskKey, realId: string | undefined) => void | Promise<void>;

  /**
   * 任务失败后的回调。
   */
  onFailed?: (taskKey: TaskKey, errorMessage: string) => void;
}

// ─────────────────────────────────────────────
// useResumableStream Hook 返回值
// ─────────────────────────────────────────────

export interface ResumableStreamResult<TData, TStartBody = unknown> {
  /** 当前活跃任务的状态快照 */
  state: StreamState<TData>;

  /**
   * 发起新任务。
   * 立即返回 pendingKey（可用于订阅进度），
   * Promise resolve 时返回服务端分配的真实 ID。
   */
  start: (body: TStartBody) => { pendingKey: PendingKey; realId: Promise<string> };

  /**
   * 手动续订已有任务（通常由 AutoResumeList 调用）。
   * @param taskKey 任务 key（pending 或 real 均可）
   * @param fromSeq 从哪个 seq 开始续订（不传则从 store 中读取 lastSeq）
   */
  resume: (taskKey: TaskKey, fromSeq?: number) => void;

  /**
   * 取消当前活跃任务的连接。
   * 不清除状态，只 abort 网络连接。
   */
  cancel: () => void;

  /**
   * 订阅指定 taskKey 的状态（不切换 activeTaskKey）。
   * 用于多任务并行场景。
   */
  getTaskState: (taskKey: TaskKey) => StreamState<TData> | undefined;
}

// ─────────────────────────────────────────────
// SSE Transport 专用类型
// ─────────────────────────────────────────────

/** SSE Transport 配置 */
export interface SseTransportOptions<TBody = unknown> {
  /**
   * SSE 端点 URL。
   *
   * 支持两种形式：
   * - `string`：直接使用（可以是绝对地址或同 origin 相对地址）
   * - `() => string`：函数式（每次连接前求值，适合需要根据 `window.location` 等
   *   客户端运行时信息动态拼接 host 的场景）
   *
   * 推荐传完整 URL（含 `https://host`），避免相对路径意外落到当前页面 origin。
   */
  url: string | (() => string);
  /**
   * 将原始 SSE 消息解析为 StreamEvent。
   * 如果返回 null，则忽略该消息。
   */
  parseMessage: (raw: unknown) => StreamEvent | null;
  /**
   * 构造请求体（合并业务参数和 resumeFromSeq）。
   *
   * 默认：从 body 中剥离内部字段 `resumeFromSeq`，按蛇形命名追加 `resume_from_seq`。
   * 如果后端期望其它字段名（例如 `from_seq`），请自行实现。
   */
  buildBody?: (body: TBody, resumeFromSeq: number) => unknown;
  /**
   * 额外的请求头。
   */
  headers?: Record<string, string>;
  /**
   * 是否携带 credentials（cookies）。
   * 默认：true
   */
  withCredentials?: boolean;
}
