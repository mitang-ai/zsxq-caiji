# 验证什么，不代表什么

自动检查只在本地或 GitHub runner 使用隔离数据运行，不在生产服务器构建或跑测试，不复用个人登录资料，不发送付费模型请求。CI 状态以 [实际执行记录](https://github.com/mitang-ai/zsxq-caiji/actions/workflows/ci.yml) 为准。

## 本次开源前检查

在独立克隆目录使用 Node **24.14.1**、官方 npm registry 与原锁定依赖完成：

| 检查 | 结果 |
| :--- | :--- |
| 干净安装与依赖审计 | `npm ci` 成功，安装时审计 0 漏洞；未升级依赖 |
| 类型与源代码格式 | 通过 |
| 单元 / 行为测试 | **112 / 112**，无跳过 |
| 生产构建 | 服务、Web、Chrome / Edge 插件均成功 |
| Web E2E | **28 项**检查通过，无页面错误 |
| Windows 运维 E2E | **6 项**检查通过 |
| Chrome / Edge 扩展宿主 | 隔离安装、导入、阅读、Markdown / ZIP 读回、重载持久化与侧栏渲染通过 |

原生扩展安装使用临时 profile 与合成材料，不操作个人浏览器账号。以上结果是这次本机执行的快照，后续提交以 CI 和实际重跑为准；不是持续稳定性或外部业务验收承诺。

## 重跑

准备 Node 24.14+、已安装的 Google Chrome，以及 `npx playwright install chromium` 安装的匹配浏览器。Linux 首次安装需对应系统依赖。CI 在 Ubuntu 24.04 跑类型、格式、单元测试、构建与 Web E2E，在 Windows 2025 单独验证基于 Windows PowerShell 的冷备恢复脚本。

```bash
npm ci
npm run typecheck
npm run format:check
npm test
npm run build
npm run test:e2e
npm run test:ops
```

`test:ops` 调用 `powershell.exe`，需在 Windows 运行；不要在 Linux 照搬这个命令。其余上述检查在 Linux/Windows 均可运行。

| 层级 | 验证内容 | 不证明 |
| :--- | :--- | :--- |
| 类型/格式 | 类型契约与源文件格式 | 运行时业务成功 |
| 单元/行为 | 权限、原文版本、引用、导入、Provider 网络边界、串行预算、未知结果和恢复 | 真实来源当前 API 与权限均可用 |
| 插件隔离浏览器测试 | 临时 Chrome profile 的 IndexedDB、任务锁、人工稿历史与恢复；storage/fetch 为 fixture | 原生权限弹窗、实际来源或自配 API 已验收 |
| 生产构建 | 服务三个入口、Web 与 Chrome/Edge MV3 产物 | 已部署或浏览器商店发布 |
| Web E2E | 隔离服务、用户/空间、资料与受控模型流程，使用合成 Provider | 真实模型质量与实际计费链路 |
| 运维 E2E | 单实例锁、IPC 启停、冷备恢复、完整性与账号恢复 | 目标服务器资源容量和 TLS 续期 |

## 外部验收仍需分开做

1. 用户自行配置连接，核验实际来源身份；在明确星球、成员和时间范围内采集。
2. 回查主题详情、正文、讨论游标与附件原件，确认覆盖说明。不以列表命中或昵称匹配推定全量。
3. 用户自行配置模型，模型发现与小测试通过后，再批准明确材料和预算，核验实际成果及引用。
4. 在目标 Chrome/Edge 中确认原生可选权限、真实同步回执及本地导出恢复。
5. 自部署逐层核验系统库、启动、HTTPS、鉴权和最小业务，不用 health 代替完整业务。

当前真实星球完整采集、正式材料上的模型加工、原生权限弹窗及所有来源原件/子回复样本仍未完成整体验收。`partial`、不可访问和未知结果均应原样报告，不以自动测试通过替代。

`test:source-anonymous` 会访问外部来源边界，不纳入默认 CI。`test:extension` / `test:extension-sync` 使用隔离扩展宿主和本地 fixture；预授予权限的运输成功不等于用户实际确认弹窗。不要为测试导出私人 Cookie、Key 或完整浏览器 profile。
