# 架构与扩展边界

## 运行形态

一个 Node 24 进程提供 Fastify API、React 静态资源和串行任务执行器，SQLite WAL 持久化元数据，原件按 SHA-256 存储。Playwright 来源浏览器按需启动，单上下文切换、空闲关闭；不是每个用户常驻一个浏览器。文件解析使用有时限/独立 V8 heap 参数的 worker。浏览器、worker、Buffer、原件 ZIP 和操作系统缓存仍消耗额外 RSS，不能把 V8 heap 限制当成整个服务资源上限。

队列查询使用 `job_queue` 索引，只反序列化当前一个待执行任务；启动恢复只读活动任务，列表查询投影成摘要，不把全历史冻结原文/已付费输出/事件传给列表。SQLite page cache 设置约 8 MiB。材料摘要只含 600 字片段，全文搜索仍在完整正文上执行，身份查询使用星球/实体复合索引。数据库内 JSON 存储便于保存完整证据和迁移，但大型单条记录仍需控制；不是无限规模数据库方案。

## 数据主线

`连接核验 → 固定范围任务 → SourceRecord → 不可变原文 revision → 专题冻结 → 明确模型计划 → 草稿/提案 → 人工 revision → 显式导出/同步`

- `user_id` / `workspace_id` 是服务端鉴权范围，不接受导入包声明权限。
- 来源实体由 `platform + group_id + entity_type + entity_id` 标识；成员限制需 `group_id + author_id`，数字 ID 始终字符串。
- 正文 SHA-256 不足以区分标题/作者/覆盖度变化，完整 `version_hash` 固定来源快照；引用和批注最终映射到不可变修订 UUID。多候选歧义拒绝，不猜最新版本。
- 真实浏览器采集标记 `server_observed`；插件/包导入是 `client_reported`，哈希完整不等于来源真实性。
- 采集材料和该任务 `saved_records` 回执在同一 SQLite transaction 写入；后续附件解析不能令已保存原文失去导出依据。
- 稿件编辑及提案采纳都核对 base revision，旧提案不能覆盖后来的人改稿。

## 凭据与网络

网页来源、官方 MCP URL、Provider Key 均是个人凭据。空闲关闭来源后 profile 加密封存，活动浏览器期间必须解密到受保护的数据目录；这不是永远无明文的零信任存储。加密主密钥与数据一起保管，冷备也包含秘密。

Provider 仅 HTTPS、无 URL 内嵌凭据、无自动 redirect，核验 DNS 后 pin 公网地址。只有系统 DNS 全部返回 198.18/198.19 Fake-IP 时才使用固定 HTTPS Cloudflare DoH 与固定 bootstrap IP，结果再次核验，Key 不进入 DNS 请求。普通私网/loopback/保留地址和混合地址仍拒绝。不会以「兼容本机代理」关闭 SSRF 检查。信任的 DoH 不可达时明确失败，不发送模型请求。更改 Provider 地址必须重新填写 Key，不把旧秘密发送到新目的地。

插件来源请求是固定业务路径，在知识星球 tab 的主世界执行；不提供任意 URL 桥、不读取或同步 Cookie。模型和工作台各有独立可选 host permission。Key/Token 不进入可移植 ZIP。

## 可维护的扩展点

1. `shared/zsxq.ts` 封装源站字段和固定路由，真实字段变化优先在此建立样本回归；不要散落 UI 中猜路由。
2. `server/source.ts` 封装网页与官方 MCP transport，返回事实状态；新增来源应实现相同受控读取边界。
3. `server/provider.ts` 隔离三种模型协议；新增服务修改协议转换而不是开放通用代理。
4. `shared/recipes.ts` 保存模板意图与输出 schema；新模板复用冻结/预算/审批/引用执行器。
5. `shared/transfer.ts` 是后续知识沉淀系统接入的版本化协议；已有精确历史引用、原件 manifest、幂等收据与覆盖度。
6. 有限工作台 MCP 使用 workspace-pinned read/process/export token；新增工具应逐个授权并建立越权测试，不开放 shell/CDP/凭据读取。

接口详见 [contracts.md](contracts.md)。改变契约同时更新服务端、插件、Web 与 round-trip 测试，不仅更新 TypeScript 类型。原文不可变、权限判定和用户预算是扩展不能绕开的不变量。
