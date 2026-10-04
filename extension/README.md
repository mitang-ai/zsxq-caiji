# 星笺 Chrome / Edge MV3 插件

运行 `npm.cmd run build:extension`，在 `chrome://extensions` 或 `edge://extensions` 开发者模式加载本机 `extension/dist/chrome` 或 `extension/dist/edge`。两个产物同源，权限与功能一致；不是浏览器商店发布。

插件本地独立工作，不要求工作台账号。侧栏用于当前帖与任务创建，完整扩展页提供 IndexedDB 资料、来源版本、专题冻结、选区批注、12 个 AI 模板、人工编辑历史、Markdown/CSV/可移植 ZIP、本机 ZIP 备份与恢复。

## 三类身份

- 知识星球登录仍在 `https://wx.zsxq.com/`；固定业务请求在该 tab 主世界执行，使用源站 Cookie 但不读取、复制或上传 Cookie。请求/响应绑定临时 nonce 与固定来源 origin；没有网页 message listener 或任意 URL fetch bridge。拒绝第三方网页发来的扩展消息。
- 自配模型从可信扩展界面直连精确授权 origin，支持 Chat Completions / Responses / Anthropic；不使用工作台模型代理。Key 默认 `chrome.storage.session`，选择记住时使用 PBKDF2-SHA256 310,000 次 + AES-256-GCM 保存在扩展 local storage，重启后手动解锁。口令不保存，忘记后只能移除保险箱重填。不是硬件保险柜。不会使用 `storage.sync` / cookies / debugger / nativeMessaging。
- 工作台设备配对使用指定 origin 与工作台人工创建的绑定空间码，Bearer 令牌仅存浏览器会话；配对不上传历史。同步预览后才传所选原文/成果/附件，保留幂等键与回执。云端账号/空间由鉴权决定，不接受包中权限声明。

## 真实覆盖度与恢复

来源路由/签名与超长数字 ID 解析共用 `shared/zsxq.ts`。星球、成员与帖 ID 保持字符串。原作者主帖、回答、评论分别归属真实作者，携带父主题 ID；成员筛选只在当前星球发生。每条命中主题另读固定详情接口，列表摘要不视为完整正文；长文读取固定 article-ID 业务接口，失败仍 partial。评论按照官方 `index` 游标串行分页，以 comment_id 去重，每帖每批 1–100 页预算；游标缺失/停滞保留主题断点，嵌套回复树不冒称已完整归档。

文件原件通过固定 file-ID download_url 业务接口读取；原图只接受固定 topic-ID + image-ID，在详情中找到同 ID 的 `original.url` 后由源站 tab 下载，调用者不能提供 URL。临时下载 URL 只留源站 tab 内存，不进入 IndexedDB、包或云端。仅下载该响应派生的 HTTPS `*.zsxq.com` 原件，拒绝重定向，单件 50 MiB 上限并流式限制体积；其他未核验 CDN、权限失败、无 image-ID 的长文内嵌图像保持 partial。图片元信息只留无查询凭据的链接。可添加本机文件，但不因此声明它等于已核验的源站附件。

子回复只检查本次真正返回、含 `comment_id` + 原作者 + `text` 的 child object；不臆造字段或额外回复 API。按真实作者分别保存，另生成只含本次所选作者节点的可读讨论 Markdown，并记录父评论/返回路径；缺失回复与未观察到的独立分页始终 partial。公开 served API chunk 尚未提供可确认的子树样本，真实登录主题验收仍待用户授权。

范围任务串行、逐页保存游标；关闭完整页后不承诺继续。重新打开检测中断：来源任务暂停，计费请求进行中则标记结果未知，不自动重试。模型任务先展示固定材料、模型外发 origin、调用次数预算；中断与截断保留说明，不切换模型掩盖失败。人工编辑使用 base revision 防止另一扩展页覆盖。

模型每批与综合请求均在发送前持久预留计费尝试；未知结果、HTTP 5xx 与用户显式重试也计入同一 `max_calls`，耗尽后不再发送。暂停仅改变控制/状态，不覆盖在途 checkpoint；当前请求 settle 前共享任务锁不释放，事件按当前库记录与旧快照合并。暂停期间返回未知/重启时仍有 inflight 请求，恢复同样要求计费风险确认。旧任务从已保存输出、发送事件与未知状态保守恢复已用次数。

partial 后续响应另存新草稿，原人工稿及其编辑历史保留。空标题、null/不支持的 JSON 对象、错误引用结构、无可回查引用不标为完成；原始已付费文本保存在 checkpoint 和待核对草稿里，不用新的计费调用覆盖坏响应。

本地 ZIP 包含 `bundle.json`、可选 `local-state.json` 与按 SHA-256 命名的附件；不包含 Key、设备 Token、源站登录态。ZIP 解压前检查声明体积与白名单路径，附件原件在任何导入写入前完成哈希核对。恢复拒绝结构化凭据字段，模型配置只恢复非凭据白名单；人工稿冲突另存，历史版本与个人标签/高亮分开保留。CSV 防公式注入。资料包哈希只证明传输完整性，来源真实性标记 client_reported。卸载扩展/清理浏览器资料前应先备份。

TransferBundle v1 使用 `recordVersionHash` 固定正文、标题、作者、覆盖度、片段和附件元信息，排除采集时刻。来源 metadata-only 更新也追加完整不可变 record 快照。便携引用/批注保留旧正文 SHA-256 `revision_id`，同时携带完整 `version_hash` 与实际历史 record；导入首先精确映射真实本机修订 UUID，再以单个 IndexedDB 事务写入。旧正文哈希或 UUID 只有唯一候选时兼容，多版本歧义/缺失引用拒绝整包，不偷偷改绑最新正文。

自包含成果包会附所选成果实际引用的固定历史原文，界面在预览和最后确认均明确告知；不会顺带发送未被引用的其他材料。另有“仅成果 Markdown（不含引用正文）”，它不是完整回查归档包。旧版没有完整 record 快照的历史只能基于现存字段恢复；不以相同正文推断同一完整版本。

本轮 29 个测试和双端构建包含跨库完整版本、旧哈希歧义、原图固定 ID 路线与可识别子节点验证，以及隔离 Chrome 全新 profile 的真实 IndexedDB/锁/恢复测试。后者使用合成 Provider fetch 和扩展 storage API fixture，不读取用户浏览器资料、不调用实际计费服务；覆盖预算耗尽、综合 unknown、人工稿保留、暂停 settle 不重发、暂停 5xx/中断仍需确认、旧任务预算迁移与坏输出 paid text 保留。它们不代表真实 MV3 权限弹窗、登录来源、自配服务、真实图片/回复样本与云端读回均已验收。实测记录由主项目 `docs/verification.md` 保存。

运行 `npx.cmd tsx --test tests/extension.test.ts` 需本机安装 Chrome；浏览器测试由 Playwright 创建并关闭隔离临时 profile，不加载个人配置。
