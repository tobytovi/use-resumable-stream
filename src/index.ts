/**
 * use-resumable-stream 主入口。
 *
 * 导出所有公共 API：
 * - 核心类型
 * - TaskKey 工具函数
 * - StreamStore
 * - SSE Transport
 * - TaskRunner
 * - React Hooks & Components（同时从主包导出，方便直接 import）
 */

// ─── 核心类型 ───────────────────────────────────
export type {
  PendingKey,
  RealKey,
  TaskKey,
  StreamStatus,
  StreamState,
  StreamEvent,
  Transport,
  TransportConnectOptions,
  SseTransportOptions,
  ResumableStreamOptions,
  ResumableStreamResult,
} from './types';

// ─── TaskKey 工具函数 ────────────────────────────
export {
  createPendingKey,
  toRealKey,
  isPendingKey,
  isRealKey,
  extractRealId,
} from './task-key';

// ─── StreamStore ─────────────────────────────────
export { createStreamStore } from './stream-store';
export type { StreamStore } from './stream-store';

// ─── SSE Transport ───────────────────────────────
export { createSseTransport } from './transports/sse';

// ─── TaskRunner ──────────────────────────────────
export { createTaskRunner } from './task-runner';
export type { TaskRunner } from './task-runner';

// ─── React API（便捷再导出）──────────────────────
export {
  StreamProvider,
  useStreamStore,
  useResumableStream,
  AutoResumeList,
} from './react/index';
export type {
  StreamProviderProps,
  AutoResumeListProps,
} from './react/index';
