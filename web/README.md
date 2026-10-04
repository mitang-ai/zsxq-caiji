# Web 前端

React 19 / TypeScript / Vite。中性浅色、深色、跟随系统与响应式布局使用 `src/styles.css` 的语义 tokens；所有业务页请求 `docs/contracts.md` 中的真实 API，不填充示例用户材料。

## 运行与验证

在项目根运行：

- `npm.cmd run dev:web`：127.0.0.1:4317；`/api`、`/mcp` 代理 4318，保留原 Host 做 Origin/CSRF 校验。
- `npm.cmd exec vite build -- --config web/vite.config.ts`：写入 `dist/web`。
- `npm.cmd run typecheck`。
- `node --import tsx --test web/tests/transfer.test.ts web/tests/listState.test.ts`：仅使用隔离内存 fixture 与 mock fetch，检查 ZIP/哈希/凭据拒绝/分片重试和列表状态隔离。
- `node --import tsx web/tests/render.mts`：**仅允许 4320 隔离 review 实例**。通过真实 Chrome UI 注册独立验收账号并导入合成材料。不会访问 4318 正式用户数据，不登录或采集源站，不调用真实模型。
- `node --import tsx web/tests/advanced.mts`：同一隔离实例，实际 ZIP 原件上传与下载读回、完整原文引用、团队明确分享、阅读返回状态、新提案手动审批计划；模型调用停在待批准。
- `node --import tsx web/tests/recovery.mts`：真实 Edge 渲染，任务 API 使用明确的 Playwright route fixture，检查失败项重试 UI、预算恢复边界、明暗主题焦点与响应式。不是采集 runtime 或外部源站验证。
- `node --import tsx web/tests/models.mts`：隔离账号、真实配置保存，Provider 发现/测试传输为 route fixture，覆盖未填模型先发现、未保存、旧 Key 目的地限制、错误与响应可见性。
- `node --import tsx web/tests/taskExport.mts`：固定任务回执的分批 JSON 下载读回，任务 API 为 route fixture；不会回退成全空间导出，不含原件。
- `node --import tsx web/tests/largeList.mts`：真实隔离 API 导入 1000 条合成材料，逐批显示、长字段、远滚动阅读返回、离线后重试；不是持续压测或生产容量结论。

截图与报告写入 `web/test-output`，不包含凭据。实际源站授权、登录挑战、第三方模型调用以及正式环境仍需要单独验证，浏览器渲染或健康检查不等于这些已通过。

## 边界

- `api.ts` 统一 Cookie/CSRF、网络错误、过期会话与可重试状态；异步旧响应不能进入新路由。
- workspace 显式包含在业务 API。源站与 Provider API 为当前用户私有，团队不会自动共享 Cookie/Key。
- 主题与保存筛选视图为 user/workspace 作用域的本机偏好；未保存稿为当前会话内的 user/workspace/artifact 草稿。
- 资料库与收件箱的筛选、选中和滚动在阅读往返中保留，按用户/空间/页面隔离；此内存状态不包含正文或凭据，显式退出会清理。
- `transfer.ts` 复用 `shared/transfer.ts` 的校验契约与 `extension/archive.ts` 的安全只读 ZIP 过滤。ZIP 下载原件需授权且匹配 SHA-256/size，导入先校验、上传/完成原件，再提交幂等业务包。
- JSON 只有附件元信息，ZIP 才携带已保存二进制。包内成果引用会携带固定历史原文。未引用旧快照、不存在的原件、凭据不随业务包导出。
- 固定引用链接使用 `?revision=`。历史原文的标题/作者来自 `record_meta`；找不到版本时不悄悄使用新原文。
- Markdown 使用 `react-markdown` + GFM，跳过 raw HTML、不启用 `rehypeRaw`；外部图片默认不请求。
- 加工先显示外发目的地、输入与预算。新增人工前稿的提案流程必须再次手动审批；采纳存在严格 base_revision 检查。
- 采集的「仅重试失败项」只提交已停止任务的已知失败范围，要求核验原来源账号；「继续断点采集」与之分开，部分任务继续分页可能增加原上限，操作前明确提示。预算暂停不显示服务端必定拒绝的恢复按钮。
- Provider 表单发现仅需要协议、Base URL 与 Key，不要求先填写模型 ID/保存。引用已有 Key 必须保持原目的地；改地址必须重新输入对应 Key。列表发现不是生成验证，实际测试响应或错误保留在同一对话框。
- 任务部分导出仅按 `saved_records` 固定版本回执或实际 `artifact_ids` 分批，下一批必须明确点击导出；旧任务无回执时不换用整星球或当前原文。JSON 包的覆盖说明标明无附件原件。
- 移动抽屉关闭时为 inert，打开时限制键盘焦点并支持 Escape 返回；小屏和平板顶栏可直接切换空间。

## 尚待外部验收

真实星球登录/身份挑战/当前成员采集、真实 Provider 模型发现与调用、AI 生成提案后采纳、外部 Agent 与插件配对均不能由本地 fixture 推断成功。200% CSS zoom 的布局检查不替代 OS DPI 或浏览器原生缩放验收。

- `npm.cmd run test:auth`：最终构建上的一键账号隔离端到端验收，包含保存、重试及再次登录。
