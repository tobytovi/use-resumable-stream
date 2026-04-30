---
"use-resumable-stream": patch
---

fix(stream-store): 支持链式 alias 解析与通知

`migrateKey` 之前只支持单层映射：A → B。如果业务侧建立了 A → B，
然后 runner 内部建立 B → C（典型场景：调用方传入外部 pendingKey，
runner 又生成自己的 internal pendingKey，最终 META 事件迁移到 realKey），
则订阅 A 的组件在状态写入到 C 后无法收到任何通知，状态读取也会
返回 undefined。

本次修复：

- `resolveKey(key)` 改为递归追溯到最终 key，并防御别名环。
- `setState(key, ...)` 写入 resolved key 后，会广播给整条别名链上
  的所有订阅者。
