/**
 * 示例：接入本项目（staro）的文字生成场景
 *
 * 展示如何用 use-resumable-stream 替代原有的
 * textStreamStore + useSWRSubscription + useTextStreamActions 方案。
 *
 * 注意：这是示例代码，不会被实际编译，仅供参考。
 */

import {
  createSseTransport,
  useResumableStream,
  AutoResumeList,
  StreamProvider,
  type StreamEvent,
} from 'use-resumable-stream';

// ─────────────────────────────────────────────
// 1. 定义业务数据类型
// ─────────────────────────────────────────────

interface TextGenData {
  content: string;
  reasoning: string;
  citations: Array<{ url: string; title: string }>;
}

// ─────────────────────────────────────────────
// 2. 定义事件解析器（对应后端协议）
// ─────────────────────────────────────────────

interface BackendEvent {
  event_type: 'META' | 'DELTA' | 'SNAPSHOT' | 'STOP' | 'ERROR' | 'HEARTBEAT';
  seq: number;
  data: {
    work_id?: string;
    content?: string;
    reasoning?: string;
    message?: string;
    citations?: Array<{ url: string; title: string }>;
  };
}

function parseBackendEvent(raw: unknown): StreamEvent | null {
  const msg = raw as BackendEvent;
  switch (msg.event_type) {
    case 'META':
      return {
        type: 'META',
        realId: String(msg.data.work_id ?? ''),
        seq: msg.seq,
      };
    case 'DELTA':
      return {
        type: 'DELTA',
        delta: { content: msg.data.content ?? '', reasoning: msg.data.reasoning ?? '' },
        seq: msg.seq,
      };
    case 'SNAPSHOT':
      return {
        type: 'SNAPSHOT',
        snapshot: { content: msg.data.content ?? '', reasoning: msg.data.reasoning ?? '' },
        seq: msg.seq,
      };
    case 'STOP':
      return { type: 'STOP', realId: String(msg.data.work_id ?? ''), seq: msg.seq };
    case 'ERROR':
      return { type: 'ERROR', message: msg.data.message ?? '未知错误', seq: msg.seq };
    case 'HEARTBEAT':
      return { type: 'HEARTBEAT' };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// 3. 创建 Transport
// ─────────────────────────────────────────────

const startTransport = createSseTransport<{
  prompt: string;
  style?: string;
}>({
  url: '/trpc.coding.staro.http/text_create',
  parseMessage: parseBackendEvent,
  withCredentials: true,
});

const resumeTransport = createSseTransport<{ workId: string }>({
  url: '/trpc.coding.staro.http/text_gen_stream',
  parseMessage: parseBackendEvent,
  buildBody: (body, resumeFromSeq) => ({
    work_id: Number(body.workId), // 后端要求 uint64
    resume_from_seq: resumeFromSeq,
  }),
  withCredentials: true,
});

// ─────────────────────────────────────────────
// 4. 事件 Reducer（核心业务逻辑）
// ─────────────────────────────────────────────

function textGenReducer(data: TextGenData, event: StreamEvent): TextGenData {
  switch (event.type) {
    case 'DELTA': {
      const delta = event.delta as { content: string; reasoning: string };
      return {
        ...data,
        content: data.content + delta.content,
        reasoning: data.reasoning + delta.reasoning,
      };
    }
    case 'SNAPSHOT': {
      const snap = event.snapshot as { content: string; reasoning: string };
      return {
        ...data,
        // ⭐ 空 snapshot 不覆盖已有内容（battle-tested guard）
        content: snap.content || data.content,
        reasoning: snap.reasoning || data.reasoning,
      };
    }
    default:
      return data;
  }
}

// ─────────────────────────────────────────────
// 5. 在组件中使用
// ─────────────────────────────────────────────

// app/layout.tsx — 根部挂载 Provider
export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <StreamProvider>
      {children}
    </StreamProvider>
  );
}

// views/create-text/TextCreateView.tsx — 创作页
export function TextCreateView() {
  const [activeWorkId, setActiveWorkId] = React.useState<string | null>(null);

  const { state, start, cancel } = useResumableStream<
    TextGenData,
    { prompt: string; style?: string }
  >(
    activeWorkId,
    {
      startTransport,
      resumeTransport,
      initialData: () => ({ content: '', reasoning: '', citations: [] }),
      onEvent: textGenReducer,
      keepAliveOnUnmount: true, // 切走再切回不丢进度
      onCompleted: async (_taskKey, realId) => {
        if (realId) {
          // 拉取落库内容兜底
          const detail = await fetchWorkDetail(realId);
          if (detail?.content) {
            // 可以通过 store 直接更新
          }
          // 刷新列表
          await refetchWorkList();
        }
      },
    },
  );

  const handleGenerate = async (prompt: string) => {
    const { pendingKey, realId } = start({ prompt });
    // pendingKey 立即可用，UI 立即响应
    setActiveWorkId(pendingKey);
    // realId resolve 后自动切换（hook 内部已处理，这里只是演示）
    const id = await realId;
    setActiveWorkId(id);
  };

  return (
    <div>
      <button
        onClick={() => handleGenerate('写一首关于大海的诗')}
        disabled={state.status === 'streaming' || state.status === 'connecting'}
      >
        开始生成
      </button>

      {state.status === 'connecting' && <p>连接中...</p>}
      {state.status === 'streaming' && (
        <>
          <p>生成中... (seq: {state.lastSeq})</p>
          <button onClick={cancel}>停止</button>
        </>
      )}
      {state.status === 'failed' && <p className="error">错误：{state.errorMessage}</p>}

      <div className="content">{state.data.content}</div>
    </div>
  );
}

// views/work-list/WorkListView.tsx — 列表页，自动续订
export function WorkListView() {
  const { data: workList } = useWorkList();

  return (
    <div>
      {/* 自动续订所有生成中的任务 */}
      <AutoResumeList
        taskKeys={
          workList
            ?.filter(w => w.status === 'GENERATING')
            .map(w => String(w.work_id)) ?? []
        }
        resumeTransport={resumeTransport}
        initialData={() => ({ content: '', reasoning: '', citations: [] })}
        onEvent={textGenReducer}
        onCompleted={async () => {
          await refetchWorkList();
        }}
      />

      {workList?.map(work => (
        <WorkCard key={work.work_id} workId={String(work.work_id)} />
      ))}
    </div>
  );
}

// 占位函数（示例用）
declare function fetchWorkDetail(id: string): Promise<{ content: string } | null>;
declare function refetchWorkList(): Promise<void>;
declare function useWorkList(): { data: Array<{ work_id: number; status: string }> | undefined };
declare const React: { useState: typeof import('react').useState };
declare function WorkCard(props: { workId: string }): JSX.Element;
