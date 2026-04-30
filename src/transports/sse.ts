/**
 * SSE Transport 实现。
 *
 * 基于 fetch + ReadableStream，不依赖 EventSource（EventSource 不支持 POST）。
 *
 * 设计要点：
 * 1. 支持 POST 请求体（EventSource 只支持 GET）
 * 2. 支持 AbortSignal 取消
 * 3. 支持 withCredentials（cookies）
 * 4. 逐行解析 SSE 格式（data: {...}\n\n）
 * 5. parseMessage 由调用方提供，实现业务协议解耦
 */
import type { Transport, TransportConnectOptions, SseTransportOptions, StreamEvent } from '../types';

/** 解析单条 SSE 行，提取 data 字段 */
function parseSseLine(line: string): string | null {
  if (line.startsWith('data:')) {
    return line.slice(5).trim();
  }
  return null;
}

/** 解析 SSE 数据块（可能包含多行） */
function* parseSseChunk(chunk: string): Generator<string> {
  const lines = chunk.split('\n');
  for (const line of lines) {
    const data = parseSseLine(line);
    if (data !== null && data !== '') {
      yield data;
    }
  }
}

/**
 * 创建 SSE Transport。
 *
 * @example
 * // 1) 字符串 URL
 * const transport = createSseTransport({
 *   url: 'https://api.example.com/chat/stream',
 *   parseMessage: (raw) => { ... },
 * });
 *
 * @example
 * // 2) 函数式 URL（适合需要客户端动态拼 host 的场景，例如
 * //    `https://${getServerHost()}/chat/stream`，避免在模块加载阶段
 * //    访问 `window` / `location` 报错）
 * const transport = createSseTransport({
 *   url: () => `https://${getServerHost()}/chat/stream`,
 *   parseMessage: (raw) => { ... },
 * });
 */
export function createSseTransport<TBody = unknown>(
  options: SseTransportOptions<TBody>,
): Transport<TBody> {
  const {
    url,
    parseMessage,
    buildBody,
    headers = {},
    withCredentials = true,
  } = options;

  return {
    async connect(
      body: TBody & { resumeFromSeq?: number },
      connectOptions: TransportConnectOptions,
    ): Promise<void> {
      const { signal, onEvent, onError, onDone } = connectOptions;
      const resumeFromSeq = body.resumeFromSeq ?? 0;

      // 构造请求体：默认剥离内部字段 resumeFromSeq，按蛇形命名追加 resume_from_seq；
      // 调用方可通过 buildBody 完全自定义（例如使用其它字段名或外层包装结构）。
      let requestBody: unknown;
      if (buildBody) {
        requestBody = buildBody(body, resumeFromSeq);
      } else {
        const sanitized: Record<string, unknown> = { ...(body as Record<string, unknown>) };
        delete sanitized.resumeFromSeq;
        sanitized.resume_from_seq = resumeFromSeq;
        requestBody = sanitized;
      }

      // 解析 url（支持函数式延迟求值）
      const resolvedUrl = typeof url === 'function' ? url() : url;

      let response: Response;
      try {
        response = await fetch(resolvedUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...headers,
          },
          body: JSON.stringify(requestBody),
          signal,
          credentials: withCredentials ? 'include' : 'same-origin',
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        onError((err as Error).message ?? '网络请求失败');
        return;
      }

      if (!response.ok) {
        onError(`HTTP ${response.status}: ${response.statusText}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError('响应体为空');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE 消息以 \n\n 分隔
          const parts = buffer.split('\n\n');
          // 最后一个可能是不完整的块，保留到下次
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            if (!part.trim()) continue;
            for (const dataStr of parseSseChunk(part)) {
              let raw: unknown;
              try {
                raw = JSON.parse(dataStr);
              } catch {
                // 非 JSON 数据忽略
                continue;
              }

              const event: StreamEvent | null = parseMessage(raw);
              if (event) {
                onEvent(event);
              }
            }
          }
        }

        // 处理 buffer 中剩余的数据
        if (buffer.trim()) {
          for (const dataStr of parseSseChunk(buffer)) {
            let raw: unknown;
            try {
              raw = JSON.parse(dataStr);
            } catch {
              continue;
            }
            const event: StreamEvent | null = parseMessage(raw);
            if (event) {
              onEvent(event);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (!signal.aborted) {
          onError((err as Error).message ?? '读取流数据失败');
        }
        return;
      } finally {
        reader.releaseLock();
      }

      onDone();
    },
  };
}
