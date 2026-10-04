import { Link } from "react-router-dom";
import { brand } from "../../../shared/brand";
import { BrandLockup, BrandMark } from "../Brand";

function PublicHeader() {
  return (
    <header className="public-header">
      <Link className="brand" to="/welcome" aria-label="集见首页">
        <BrandLockup />
      </Link>
      <nav aria-label="网站导航">
        <Link to="/plugins">本地插件</Link>
        <a href={brand.repository}>GitHub ↗</a>
        <Link className="button" to="/login">
          打开工作台
        </Link>
      </nav>
    </header>
  );
}
function PublicFooter() {
  return (
    <footer className="public-footer">
      <span>集内容，见门道。</span>
      <span>集见 {brand.version} · 独立工具，非知识星球官方产品</span>
      <a href={`${brand.repository}/blob/main/LICENSE`}>MIT 开源 ↗</a>
    </footer>
  );
}
export function LandingPage() {
  return (
    <div className="public-shell">
      <PublicHeader />
      <main id="main-content" className="public-main">
        <section className="landing-hero">
          <div className="hero-copy">
            <p className="public-kicker">知识星球采集与整理工作台</p>
            <h1>
              好内容，
              <br />
              别只收藏。
            </h1>
            <p className="hero-description">
              {brand.description}
              <br />
              留下原文，也留下自己的见解。
            </p>
            <div className="hero-actions">
              <Link className="button primary" to="/login">
                打开工作台 <span aria-hidden="true">↗</span>
              </Link>
              <Link className="button" to="/plugins">
                安装本地插件
              </Link>
            </div>
            <p className="hero-note">
              Chrome / Edge · 插件独立使用 · 模型 API 自配
            </p>
          </div>
          <div className="hero-mark">
            <BrandMark size={310} animated />
            <span>一页好内容，接住再读。</span>
          </div>
        </section>
        <ol className="landing-flow" aria-label="工作流程">
          <li>
            <span>01</span>
            <strong>收进来</strong>
            <p>选星球、成员和时间范围，保留原文与来源。</p>
          </li>
          <li>
            <span>02</span>
            <strong>读明白</strong>
            <p>阅读、批注、选材。让模型带着引用，帮你理清讨论。</p>
          </li>
          <li>
            <span>03</span>
            <strong>用起来</strong>
            <p>自己改稿，整理专题，或把资料和成果导到本地。</p>
          </li>
        </ol>
        <section className="landing-scenes" aria-labelledby="scenes-title">
          <div className="section-intro">
            <p className="public-kicker">从一件具体的事开始</p>
            <h2 id="scenes-title">
              不是多存一点，
              <br />
              是多用一点。
            </h2>
          </div>
          <div className="scene-list">
            <article>
              <span>成员研究</span>
              <h3>一个人，在这个星球里说过什么？</h3>
              <p>
                按作者 ID
                固定范围。把观点、案例和讨论放在一起读，不把其他星球的内容混进来。
              </p>
            </article>
            <article>
              <span>专题整理</span>
              <h3>零散的讨论，拼成一份能回查的资料。</h3>
              <p>先选原文，再看计划与预算。模型出草稿，你保留最后的修改权。</p>
            </article>
            <article>
              <span>本地带走</span>
              <h3>不想放在云端？就在自己的浏览器里做。</h3>
              <p>
                插件无需工作台账号。阅读与导出不需要模型；同步到 Web
                必须由你确认。
              </p>
            </article>
          </div>
        </section>
        <section className="landing-boundaries">
          <h2>用之前，把边界说清楚。</h2>
          <div>
            <p>
              <strong>采集在你的权限内。</strong> 官方 MCP
              和网页登录都保留。网页登录不要求球主开启
              MCP，但不能读取账号不可见的内容。
            </p>
            <p>
              <strong>原文不是“全部成功”的保证。</strong>{" "}
              缺页、附件失败与中断会留下覆盖说明，方便核对和恢复。
            </p>
            <p>
              <strong>加工先看计划。</strong> API
              可能计费，所选文本会发给你配置的模型服务。人工批准不因包装而省略。
            </p>
          </div>
        </section>
        <section className="landing-final">
          <h2>先收一小批，慢慢读。</h2>
          <Link className="button primary" to="/register">
            创建工作台账号 ↗
          </Link>
          <Link to="/plugins">或直接使用本地插件</Link>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
export function PluginsPage() {
  const release = `${brand.repository}/releases/download/v${brand.version}`;
  return (
    <div className="public-shell">
      <PublicHeader />
      <main id="main-content" className="public-main plugins-main">
        <p className="public-kicker">集见 · 本地版 / {brand.version}</p>
        <h1>
          自己的内容，
          <br />
          先留在自己这里。
        </h1>
        <p className="hero-description">
          使用你已登录的知识星球。采集、整理和导出独立完成，
          <br />
          需要时，再把选定材料同步到工作台。
        </p>
        <div className="download-grid">
          {(["chrome", "edge"] as const).map((browser) => (
            <article key={browser}>
              <BrandMark size={48} />
              <h2>{browser === "chrome" ? "Chrome" : "Microsoft Edge"}</h2>
              <p>
                适用于桌面浏览器
                120+。当前通过开发者模式安装，尚未上架扩展商店。
              </p>
              <a
                className="button primary"
                href={`${release}/jijian-${browser}-v${brand.version}.zip`}
              >
                下载 {browser === "chrome" ? "Chrome" : "Edge"} 插件 ↓
              </a>
            </article>
          ))}
        </div>
        <section className="install-section">
          <h2>三步装好，不需要 Node。</h2>
          <ol>
            <li>
              <strong>下载并解压。</strong>{" "}
              保留整个文件夹，更新时在原文件夹覆盖文件，不删除本地数据库。
            </li>
            <li>
              <strong>打开扩展管理。</strong> Chrome 打开{" "}
              <code>chrome://extensions</code>，Edge 打开{" "}
              <code>edge://extensions</code>。启用「开发者模式」。
            </li>
            <li>
              <strong>加载已解压的扩展。</strong> 选择含{" "}
              <code>manifest.json</code>{" "}
              的文件夹。固定图标，点击打开侧栏；也可用 <kbd>Alt</kbd> +{" "}
              <kbd>Shift</kbd> + <kbd>J</kbd>。
            </li>
          </ol>
          <p>
            首次使用先打开知识星球并登录，再按提示授权当前来源。模型配置可跳过。
          </p>
          <p>
            更新前先在插件「导出与备份」保存一份备份。卸载扩展或清除浏览器数据可能删除本地资料；跨浏览器迁移请使用备份恢复。
          </p>
          <a href={`${brand.repository}/blob/main/docs/plugin-install.md`}>
            查看更新、恢复与排错说明 ↗
          </a>
        </section>
        <section className="landing-boundaries">
          <h2>哪些会离开本机？</h2>
          <div>
            <p>
              <strong>读取来源：</strong> 请求知识星球，需要你授权来源域名。
            </p>
            <p>
              <strong>模型加工：</strong> 选定文本发送到你授权的 API，可能计费。
            </p>
            <p>
              <strong>同步工作台：</strong>{" "}
              先配对，再预览与确认材料。历史不会自动上传。
            </p>
          </div>
        </section>
        <p className="download-meta">
          <a href={`${release}/SHA256SUMS`}>下载 SHA-256 校验值</a> ·{" "}
          <a href={`${brand.repository}/releases/tag/v${brand.version}`}>
            发行说明
          </a>{" "}
          · 两个浏览器同一代码与数据契约，分别发布
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
