/**
 * StreamProvider：应用级 Provider，承载 StreamStore 单例。
 *
 * 设计要点：
 * - 单例 store 存活于整个应用生命周期，不随组件卸载而销毁
 * - 通过 Context 向下传递 store 引用
 * - 支持自定义 store（测试/多实例场景）
 */
import { createContext, useContext, useRef, type ReactNode } from 'react';
import { createStreamStore, type StreamStore } from '../stream-store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StreamStoreContext = createContext<StreamStore<any> | null>(null);

export interface StreamProviderProps {
  children: ReactNode;
  /**
   * 自定义 store 实例（可选）。
   * 不传则自动创建单例。
   * 用于测试或需要多个独立 store 的场景。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store?: StreamStore<any>;
}

/**
 * StreamProvider：在应用根部挂载，提供全局 StreamStore。
 *
 * @example
 * // app/layout.tsx
 * import { StreamProvider } from 'use-resumable-stream/react';
 *
 * export default function RootLayout({ children }) {
 *   return (
 *     <StreamProvider>
 *       {children}
 *     </StreamProvider>
 *   );
 * }
 */
export function StreamProvider({ children, store: externalStore }: StreamProviderProps) {
  // 使用 useRef 保证 store 单例在组件重渲染时不重建
  const storeRef = useRef<StreamStore<unknown>>(
    externalStore ?? createStreamStore<unknown>(),
  );

  return (
    <StreamStoreContext.Provider value={storeRef.current}>
      {children}
    </StreamStoreContext.Provider>
  );
}

/**
 * 获取当前 StreamStore 实例。
 * 必须在 StreamProvider 内部使用。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStreamStore<T = any>(): StreamStore<T> {
  const store = useContext(StreamStoreContext);
  if (!store) {
    throw new Error(
      '[use-resumable-stream] useStreamStore 必须在 <StreamProvider> 内部使用。\n' +
      '请在应用根部添加 <StreamProvider>。',
    );
  }
  return store as StreamStore<T>;
}
