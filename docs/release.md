# 本地制作发行包，服务器只运行

发行脚本在本地 Linux x86_64 / WSL Ubuntu 执行，不连接服务器、不构建应用、不安装系统包、不启动浏览器。先本地构建并验证，再冻结 `dist`；服务器只接收发行产物。

## 制作

在同一项目目录执行：

```bash
npm ci
npm run build
bash scripts/package-release.sh --prepare-only
bash scripts/package-release.sh --offline --tag <新的安全标签>
```

Windows 可在 PowerShell 完成本地构建，再从 WSL 进入该项目运行两个 Bash 命令。打包依赖 WSL/Linux 的 `curl`、`tar`、`xz`、`sha256sum`、`find`、`ldd`、`realpath` 和 `cp`，不会把 Windows `node_modules` 复制过去。

准备模式下载固定 Node **24.14.1 Linux x64**、当前 `dist/package.json` 锁定的生产依赖和匹配的 Playwright Chromium headless shell / FFmpeg。Node 原始归档按官方 HTTPS 校验清单验证 SHA-256；这不是签名验证。`--offline` 缺缓存即失败，不静默换版本。

下载、npm 配置与缓存隔离在本地专用缓存中，清理继承的认证、preload 与替代下载地址环境变量。生产依赖保留 PDFJS 所需资源与 Linux canvas 预编译模块，不在服务器编译。浏览器版本取自实际依赖；不要用 `XINGJIAN_BROWSER_CHANNEL` 换成其他浏览器。

标签不重复，旧包不覆盖。冻结构建后打包；如果再次构建，使用新标签，并重新核对 manifest。

## 产物

项目 `release/` 输出同名文件：

| 文件 | 内容 |
| :--- | :--- |
| `*-app.tar.gz` | 三个服务入口、Web 静态资源、Linux Node、生产依赖、启动/预检脚本、内部校验清单 |
| `*-browser.tar.gz` | 匹配浏览器运行文件与校验清单，和 app 使用相同顶层目录 |
| `*-manifest.json` | Node / 依赖 / 浏览器 revision，构建文件哈希与验证边界 |
| `*-SHA256SUMS` | 归档及说明证据的校验值 |
| `*-local-libraries.txt` | 本机 Linux 的架构、glibc 与 `ldd` 信息，**不是目标服务器依赖证明** |

构建输出使用白名单并拒绝 symlink、隐藏文件和疑似凭据路径。发行包不含 `data/`、`var/`、`.env`、Key、Cookie、源站 profile 或测试输出；仍须审查源码是否嵌入秘密。新数据默认在包目录 `var/data`，生产应另设持久路径。

## 目标机器部署

先确认 Linux x86_64、目标系统共享库、空闲端口和其他项目边界。使用独立代码/数据目录、独立非 root 服务用户及仅绑定 loopback 的服务；不覆盖现有站点或通用代理配置。

以下为部署模板，不是实际执行记录：

```bash
sha256sum -c <name>-SHA256SUMS
tar --no-same-owner -xzf <name>-app.tar.gz
tar --no-same-owner -xzf <name>-browser.tar.gz
cd <name>
bash bin/preflight.sh
```

预检只查完整性、动态共享库和模块导入，不启动服务/浏览器，不读取账号。出现 `not found` 就停止，由管理员按目标发行版补齐官方支持的依赖；不要盲拷其他发行版系统库。

配置真实 HTTPS 反代与持久数据目录后启动：

```bash
export NODE_ENV=production
export XINGJIAN_PUBLIC_URL='https://your-domain.example'
export XINGJIAN_DATA_DIR='/srv/xingjian-data'
export PORT=4318
bash bin/run.sh
```

上面是示例地址和路径，必须替换。启动器强制 `HOST=127.0.0.1`；仅在确认可信代理边界后设置 `XINGJIAN_TRUST_PROXY=1`。脚本不生成域名、证书、Nginx、宝塔或 systemd 配置。

停止用 `SIGTERM` / 前台 `Ctrl+C`；启用 `XINGJIAN_LOCAL_CONTROL=1` 后，也可用 `bash bin/run.sh control status` / `control stop`。升级前停止服务、冷备整个持久目录，保留代码与数据的同时间点回滚方案。[冷备和恢复 →](runbook.md)

## 小服务器的边界

- 默认 V8 heap 上限 512 MiB，不等于 Node 总 RSS 上限，更不限制浏览器或 OS 缓存，不能保证 2 GiB 不发生 OOM。
- 保持单进程、串行任务与按需浏览器。复杂 PDF、长历史仍需观察实际资源，不用预检替代容量测试。
- OS 共享库与字体不在包内，浏览器下载成功不等于目标机器可启动或可采集。
- 后续若只更新应用，可仅传 app；依赖/浏览器 revision 变化时必须匹配更新 browser。
- 按层验证：归档 → 系统依赖 → 启动/health → 登录/最小业务 → 真实来源/模型。没做的层不标通过。

参考：[Node 24.14.1](https://nodejs.org/en/download/archive/v24.14.1)、[Node 平台要求](https://github.com/nodejs/node/blob/v24.14.1/BUILDING.md)、[Playwright 浏览器与系统依赖](https://playwright.dev/docs/browsers)。
