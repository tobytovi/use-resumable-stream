---
"use-resumable-stream": minor
---

Initial release of `use-resumable-stream`.

## Features

- `useResumableStream` hook — resumable SSE streams with `useSyncExternalStore`
- `createSseTransport` — fetch-based SSE transport (supports POST, AbortSignal)
- `StreamProvider` + `useStreamStore` — app-level singleton store
- `AutoResumeList` — auto-resume in-progress tasks on page load
- `createTaskRunner` — task execution engine with exponential backoff retry
- `createStreamStore` — framework-agnostic state store

## Battle-tested Guards

- Empty SNAPSHOT won't overwrite existing content
- Pending key never sent to backend
- Terminal state tasks won't be re-subscribed
- Connection survives tab switch (`keepAliveOnUnmount: true`)
