# use-resumable-stream

> **useChat, but resumable.** Survives tab switch, refresh, and network drops.

[![npm version](https://img.shields.io/npm/v/use-resumable-stream)](https://www.npmjs.com/package/use-resumable-stream)
[![bundle size](https://img.shields.io/bundlephobia/minzip/use-resumable-stream)](https://bundlephobia.com/package/use-resumable-stream)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org/)

A React hook library for **resumable SSE streams** — designed for LLM generation, long-running tasks, and any streaming API that needs to survive tab switches, page refreshes, and network drops.

## Why not Vercel AI SDK?

| Feature | Vercel AI SDK | use-resumable-stream |
|---|:---:|:---:|
| SSE streaming | ✅ | ✅ |
| **Resume after disconnect** | ❌ | ✅ |
| **Survive tab switch** | ❌ | ✅ |
| **Custom backend protocol** | ❌ | ✅ |
| **Two-phase task ID** (pending → real) | ❌ | ✅ |
| **Multi-task parallel** | ❌ | ✅ |
| **Auto-resume list** | ❌ | ✅ |
| Vercel-only backend | Required | Not required |

## Installation

```bash
npm install use-resumable-stream
# or
pnpm add use-resumable-stream
```

## Quick Start

### 1. Wrap your app with `StreamProvider`

```tsx
// app/layout.tsx (Next.js) or main.tsx (Vite)
import { StreamProvider } from 'use-resumable-stream';

export default function RootLayout({ children }) {
  return (
    <StreamProvider>
      {children}
    </StreamProvider>
  );
}
```

### 2. Define your transport and event reducer

```tsx
import { createSseTransport } from 'use-resumable-stream';

// Define the shape of your streaming data
interface ChatData {
  content: string;
  reasoning: string;
}

// Create a transport that connects to your SSE endpoint
const startTransport = createSseTransport<{ prompt: string }>({
  url: '/api/chat/start',
  parseMessage: (raw) => {
    const msg = raw as { event_type: string; seq: number; data: unknown };
    switch (msg.event_type) {
      case 'META':
        return { type: 'META', realId: (msg.data as { work_id: string }).work_id, seq: msg.seq };
      case 'DELTA':
        return { type: 'DELTA', delta: (msg.data as { content: string }).content, seq: msg.seq };
      case 'SNAPSHOT':
        return { type: 'SNAPSHOT', snapshot: (msg.data as { content: string }).content, seq: msg.seq };
      case 'STOP':
        return { type: 'STOP', seq: msg.seq };
      case 'ERROR':
        return { type: 'ERROR', message: (msg.data as { message: string }).message, seq: msg.seq };
      case 'HEARTBEAT':
        return { type: 'HEARTBEAT' };
      default:
        return null;
    }
  },
});

const resumeTransport = createSseTransport<{ workId: string }>({
  url: '/api/chat/resume',
  buildBody: (body, resumeFromSeq) => ({
    work_id: body.workId,
    resume_from_seq: resumeFromSeq,
  }),
  parseMessage: startTransport.parseMessage, // reuse same parser
});
```

### 3. Use the hook in your component

```tsx
import { useResumableStream } from 'use-resumable-stream';

function ChatView({ activeWorkId }: { activeWorkId: string | null }) {
  const { state, start, resume, cancel } = useResumableStream<ChatData, { prompt: string }>(
    activeWorkId,
    {
      startTransport,
      resumeTransport,
      initialData: () => ({ content: '', reasoning: '' }),

      // ⭐ The core: event reducer
      // Empty SNAPSHOT won't overwrite existing content (battle-tested guard)
      onEvent: (data, event) => {
        switch (event.type) {
          case 'DELTA':
            return { ...data, content: data.content + (event.delta as string) };
          case 'SNAPSHOT': {
            const snap = event.snapshot as string;
            return snap ? { ...data, content: snap } : data; // guard: empty snapshot won't overwrite
          }
          default:
            return data;
        }
      },

      // Keep connection alive when component unmounts (tab switch won't kill it)
      keepAliveOnUnmount: true,

      // Called when generation completes
      onCompleted: async (taskKey, realId) => {
        console.log('Generation complete:', realId);
        await refetchWorkList(); // refresh your list
      },
    },
  );

  const handleGenerate = () => {
    start({ prompt: 'Write a poem about the sea' });
  };

  return (
    <div>
      <button onClick={handleGenerate} disabled={state.status === 'streaming'}>
        Generate
      </button>
      <button onClick={cancel} disabled={state.status !== 'streaming'}>
        Stop
      </button>

      {state.status === 'connecting' && <p>Connecting...</p>}
      {state.status === 'streaming' && <p>Generating... (seq: {state.lastSeq})</p>}
      {state.status === 'failed' && <p>Error: {state.errorMessage}</p>}

      <div>{state.data.content}</div>
    </div>
  );
}
```

### 4. Auto-resume in-progress tasks on page load

```tsx
import { AutoResumeList } from 'use-resumable-stream';

function WorkListPage() {
  const { data: workList } = useWorkList();

  return (
    <div>
      {/* Automatically resumes all in-progress tasks */}
      <AutoResumeList
        taskKeys={workList
          ?.filter(w => w.status === 'GENERATING')
          .map(w => String(w.work_id)) ?? []}
        resumeTransport={resumeTransport}
        initialData={() => ({ content: '', reasoning: '' })}
        onEvent={chatEventReducer}
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

// In WorkCard, subscribe to the stream state
function WorkCard({ workId }: { workId: string }) {
  const store = useStreamStore<ChatData>();
  const streamState = useSyncExternalStore(
    (listener) => store.subscribe(workId, listener),
    () => store.getState(workId),
  );

  if (streamState?.status === 'streaming') {
    return <div className="generating">{streamState.data.content}</div>;
  }
  // ...
}
```

## API Reference

### `<StreamProvider>`

Application-level provider. Must wrap your entire app.

```tsx
<StreamProvider store={optionalCustomStore}>
  {children}
</StreamProvider>
```

### `useResumableStream(activeTaskKey, options)`

Core hook for managing a resumable stream.

**Parameters:**
- `activeTaskKey: TaskKey | null` — The currently active task key to subscribe to
- `options: ResumableStreamOptions<TData, TStartBody, TResumeBody>`

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `startTransport` | `Transport` | — | Transport for starting new tasks |
| `resumeTransport` | `Transport` | — | Transport for resuming tasks |
| `initialData` | `() => TData` | Required | Factory for initial data |
| `onEvent` | `(data, event) => data` | Required | Event reducer |
| `keepAliveOnUnmount` | `boolean` | `true` | Keep connection alive on unmount |
| `retryDelays` | `number[]` | `[1000, 2000, 4000]` | Retry backoff delays (ms) |
| `onCompleted` | `(key, realId) => void` | — | Called on STOP event |
| `onFailed` | `(key, message) => void` | — | Called on ERROR event |

**Returns:**

| Property | Type | Description |
|---|---|---|
| `state` | `StreamState<TData>` | Current stream state |
| `start` | `(body) => { pendingKey, realId }` | Start a new task |
| `resume` | `(taskKey, fromSeq?) => void` | Manually resume a task |
| `cancel` | `() => void` | Cancel current connection |
| `getTaskState` | `(taskKey) => StreamState \| undefined` | Read any task's state |

### `createSseTransport(options)`

Creates an SSE transport using `fetch` + `ReadableStream` (supports POST).

```tsx
const transport = createSseTransport({
  url: '/api/stream',
  parseMessage: (raw) => { /* return StreamEvent or null */ },
  buildBody: (body, resumeFromSeq) => ({ ...body, resume_from_seq: resumeFromSeq }),
  headers: { 'X-Custom-Header': 'value' },
  withCredentials: true, // default
});
```

### `<AutoResumeList>`

Automatically resumes all in-progress tasks from a list.

```tsx
<AutoResumeList
  taskKeys={['123', '456', '789']}
  resumeTransport={resumeTransport}
  initialData={() => initialState}
  onEvent={reducer}
  onCompleted={handleCompleted}
/>
```

### Stream Event Types

```ts
type StreamEvent =
  | { type: 'META'; realId: string; seq: number }      // Server assigned real ID
  | { type: 'DELTA'; delta: unknown; seq: number }     // Incremental data
  | { type: 'SNAPSHOT'; snapshot: unknown; seq: number } // Full snapshot (overwrite)
  | { type: 'STOP'; realId?: string; seq: number }     // Natural end
  | { type: 'ERROR'; message: string; seq: number }    // Business error
  | { type: 'HEARTBEAT' };                             // Keepalive (no seq advance)
```

### Stream Status

```ts
type StreamStatus =
  | 'idle'        // Not started
  | 'connecting'  // Establishing connection
  | 'streaming'   // Receiving data
  | 'completed'   // Finished (STOP event)
  | 'failed';     // Error (ERROR event or retries exhausted)
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Your React Components                                  │
│  useResumableStream() / AutoResumeList                  │
└──────────────────────┬──────────────────────────────────┘
                       │ useSyncExternalStore
┌──────────────────────▼──────────────────────────────────┐
│  StreamStore (singleton, app-level)                     │
│  Map<TaskKey, StreamState> + Listeners                  │
│  pendingKey → realKey alias mapping                     │
└──────────────────────┬──────────────────────────────────┘
                       │ read/write
┌──────────────────────▼──────────────────────────────────┐
│  TaskRunner                                             │
│  - Manages SSE connections                              │
│  - Exponential backoff retry                            │
│  - pendingKey → realKey migration                       │
│  - Deduplication (no double connections)                │
└──────────────────────┬──────────────────────────────────┘
                       │ connect()
┌──────────────────────▼──────────────────────────────────┐
│  Transport (pluggable)                                  │
│  createSseTransport() / custom WebSocket / HTTP polling │
└─────────────────────────────────────────────────────────┘
```

## Battle-tested Guards

This library was extracted from a production LLM writing app. Every guard below was added after a real bug:

| Guard | Problem it solves |
|---|---|
| `keepAliveOnUnmount: true` | Tab switch kills connection → progress lost |
| Empty SNAPSHOT check in `onEvent` | Resume returns empty snapshot → content wiped |
| `isPendingKey()` check before network | Pending key sent to backend → 400 error |
| Terminal state check before resume | Completed task re-subscribed → content overwritten |
| `useSyncExternalStore` (not SWR cache) | Write to SWR cache, read from subscription → no update |
| Alias map (pendingKey → realKey) | `activeWorkId` switches before realId arrives → blank screen |

## License

MIT
