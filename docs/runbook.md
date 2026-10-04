# 本机运行与故障恢复

## 启停

先在项目根本地构建，确认 4318 未被占用：

```powershell
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

启动器隐藏窗口，写入 `data/stdout.log`、`data/stderr.log` 和进程信息；所有私人数据在 `data/`。本地 IPC 控制信息也在此，含秘密 Token，不应在聊天/日志中打印。查询状态和停止：

```powershell
node.exe dist/server/index.mjs control status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-local.ps1
```

存在运行任务则停止被拒绝。先在界面暂停任务；确实要中断运行任务才使用 `-CancelRunning`。结果未知的已发送请求不会自动重试。等待进程退出和 `runtime.lock` 移除，不强杀 Node 或删掉锁文件假装收尾完成。

## 冷备、恢复与升级

1. 停服务并确认没有仍使用来源 profile 的孤儿浏览器。
2. 备份到**新的、位于数据目录之外**的目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-local.ps1 -Destination 'D:\私有备份\xingjian-新时间戳'
```

3. 冷备包含 SQLite/WAL、附件、账号、登录 session、Provider 密文和主密钥。私有保存，不能上传到发行目录或 Git；不要只备份 `.sqlite`。
4. 新版代码本地构建/验证后替换代码；不要替换私人数据。必要时回退代码与完整同时间点冷备。
5. 演练恢复到新的空目录，脚本先检查全清单和哈希，拒绝覆盖已有目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-local.ps1 -Backup 'D:\私有备份\xingjian-新时间戳' -Destination 'D:\私有恢复\xingjian-新目录'
node.exe dist/server/admin.mjs verify --data-dir 'D:\私有恢复\xingjian-新目录'
```

`-IncludeUnsealedOfflineProfiles` 仅用于已停进程的崩溃恢复情形；先确认相关浏览器也停止。它不是跳过活动来源保护的常规选项。

## 账号恢复

没有模拟「邮件发送成功」。管理员在服务停止、确认用户邮箱后生成新的单次令牌文件：

```powershell
node.exe dist/server/admin.mjs recovery --data-dir 'D:\私有数据\xingjian' --email '用户填写的邮箱' --output 'D:\私有恢复\新令牌文件.json'
```

令牌 30 分钟有效，文件只私下交给本人。启动服务，用户在恢复页提交令牌和新密码；成功后旧 session 被撤销。不要把令牌写到聊天或截图。

## 常见故障

| 状态 | 排查与处理 |
|---|---|
| `private_network_denied` | 检查 Base URL 是否实际私网。Fake-IP 专用核验失败时会返回 `dns_verification_failed`，不要关闭安全检查或填明文 HTTP |
| 模型列表不支持 | 可手填确切 model ID；没有列表不等于实际推理成功，另做一次小测试 |
| Provider 401/403 | 用户自行核对 Key/服务权限；别把 Key 发到聊天；换地址必须重填 |
| `login_required` / `identity_changed` | 回来源窗口由用户登录/核验原账号；不会换账号继续任务 |
| 官方 `policy_denied` | 官方能力没开或拒绝。选择自己的已核验网页连接和明确范围，不把拒绝当空内容 |
| `partial` | 看正文/讨论/原件各阶段和失败原因，可仅重试已知失败项；不因 HTTP200 宣称全量 |
| `outcome_unknown` | 可能计费，默认停；保留断点，只有用户确认后重试，仍计入原预算 |
| `budget_paused` | 保留当前成果，新建明确预算计划；不在后台抬高原预算 |
| 提案/编辑409 | 原稿已有后来修改，重新读最新版本后处理，不强行覆盖 |
| 端口被占用/已有执行器 | 查询已有进程，不启动第二实例，不对未知进程强杀 |
| PDF无文字 | 保存原件，可能扫描件/加密/提取失败；本系统不做OCR |
| 同步/原件失败 | 依据真实 offset/hash/回执续传，重复确认不会重复导入；ZIP哈希错误在写入前拒绝 |

## 生产准备

自部署先确认非 root 运行用户、独立持久数据、HTTPS 域名、Nginx loopback 反代、备份与回滚。只上传 [Linux 发行包](release.md)，不迁入开发机的账号、登录态或 Key。小服务器不构建、不跑测试套件、不并发创建浏览器/任务，只做必要启动核验和最小健康读回。预检与 health 读回不代表真实来源 / 模型业务已验收。本站点 TLS、续期与进程管理应使用独立配置，不修改其他项目的配置。

Linux 开发机首次使用网页登录，可按本机发行版执行 `npx playwright install --with-deps chromium`；服务器依赖须按 [发行说明](release.md) 单独核验，不能照搬开发机安装流程。
