# use-resumable-stream

## 0.2.0

### Minor Changes

- 64139d0: Initial release of `use-resumable-stream`.

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

- d318214: Initial release: resumable SSE streaming hook for React. Survives tab switch, refresh, and network drops.
