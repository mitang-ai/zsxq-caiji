# 参与集见

先读 [功能边界](docs/features.md) 和 [架构](docs/architecture.md)，再动相关模块。提交问题时写清浏览器/Node 版本、操作步骤、期望结果和实际结果；日志只附必要片段，并去掉凭据与私人内容。

## 本地开发

按 [README](README.md#快速开始) 安装依赖与浏览器。使用独立测试账号和数据目录，不复用个人或生产数据。Web 开发见 [web/README.md](web/README.md)。

提交前运行：

```bash
npm run typecheck
npm run format:check
npm test
npm run build
```

涉及界面、打包或启停恢复，再运行 `npm run test:e2e` 和 `npm run test:ops`。测试环境和边界见 [验证说明](docs/verification.md)。

## Pull Request

- 一次解决一个明确问题，说明修改原因、验证命令与未验证项。
- 行为变化附回归测试，协议变化同步契约文档。
- 保留来源 ID、版本、覆盖状态和权限校验，不用吞异常或伪成功修测试。
- 不提交数据目录、Key、Cookie、浏览器 profile、个人原文、备份和测试输出。
- 真实来源验证由你自行授权、限定范围；自动测试用合成样本，不发送付费模型请求。

提交即表示你有权按本仓库 MIT License 提供这些改动。安全问题请先看 [SECURITY.md](SECURITY.md)，不要贴公开可利用的凭据或私人材料。
