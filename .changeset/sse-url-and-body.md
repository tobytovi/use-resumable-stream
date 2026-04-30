---
'use-resumable-stream': minor
---

`createSseTransport` 增强：

- `url` 选项新增函数式签名 `() => string`，每次连接前求值。便于在客户端运行时根据
  `window.location` 等动态拼接绝对 URL，避免相对路径意外落到当前页面 origin 的问题。
- 默认 `buildBody` 现在会从请求体中剥离内部字段 `resumeFromSeq`，仅以 `resume_from_seq`
  传给后端，避免内部字段污染业务请求体。
