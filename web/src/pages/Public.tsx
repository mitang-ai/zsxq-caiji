import { Link } from "react-router-dom";
import { brand } from "../../../shared/brand";
import { BrandMark } from "../Brand";
import { AppearanceSelect, type AppearanceProps } from "../Appearance";

function PublicHeader(props: AppearanceProps) {
  return (
    <header className="public-header">
      <Link className="public-brand" to="/welcome" aria-label="集见首页">
        <BrandMark size={26} />
        <strong>集见</strong>
      </Link>
      <nav aria-label="网站导航">
        <Link to="/plugins">本地插件</Link>
        <a href={brand.repository}>GitHub</a>
        <AppearanceSelect {...props} />
        <Link className="button" to="/login">
          工作台
        </Link>
      </nav>
    </header>
  );
}
function PublicFooter() {
  return (
    <footer className="public-footer">
      <span>集见 {brand.version}</span>
      <span>独立工具，非知识星球官方产品</span>
      <a href={`${brand.repository}/blob/main/LICENSE`}>MIT 开源</a>
    </footer>
  );
}
export function LandingPage(props: AppearanceProps) {
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main-content">
        跳到内容
      </a>
      <PublicHeader {...props} />
      <div className="public-layout">
        <aside className="public-index" aria-label="使用指南">
          <p>使用指南</p>
          <a href="#collect">采集与阅读</a>
          <a href="#process">加工与成果</a>
          <a href="#local">本地插件</a>
          <a href="#boundaries">权限与数据</a>
        </aside>
        <main id="main-content" className="public-main">
          <section className="public-intro">
            <p className="intro-label">知识星球工作台</p>
            <h1>把讨论整理成自己的资料</h1>
            <p>
              选择你加入的星球，或当前星球的一位成员。保留原文与附件，整理专题，再按需要生成带引用的草稿。
            </p>
            <div className="intro-actions">
              <Link className="button primary" to="/login">
                打开工作台
              </Link>
              <Link className="button" to="/plugins">
                安装本地插件
              </Link>
            </div>
            <p className="intro-note">
              插件无需工作台账号。阅读和导出不要求配置模型。
            </p>
          </section>
          <section id="collect" className="public-section">
            <h2>采集与阅读</h2>
            <dl className="feature-rows">
              <div>
                <dt>按范围采集</dt>
                <dd>
                  固定星球、作者 ID、时间与内容类型。成员采集始终限于当前星球。
                </dd>
              </div>
              <div>
                <dt>留下原文</dt>
                <dd>
                  正文、讨论和附件分别记录覆盖情况。缺页与中断有说明，不冒充完整归档。
                </dd>
              </div>
              <div>
                <dt>继续整理</dt>
                <dd>
                  搜索、标签、收藏、批注和专题选材。原文更新后，旧稿引用仍固定到当时版本。
                </dd>
              </div>
            </dl>
          </section>
          <section id="process" className="public-section">
            <h2>加工与成果</h2>
            <p>
              模型帮你读材料，不替你决定哪些内容外发。执行前先看选材、模型服务和调用预算，再确认加工。
            </p>
            <div className="process-line">
              <span>选择材料</span>
              <span>核对计划</span>
              <span>确认加工</span>
              <span>编辑草稿</span>
            </div>
            <p>
              人工稿保存编辑历史。重新加工生成新提案，不直接覆盖你的修改。成果可以导出为
              Markdown 或带原件的材料包。
            </p>
          </section>
          <section id="local" className="public-section">
            <h2>本地插件</h2>
            <p>
              Chrome 和 Edge
              使用同一套功能。资料保存在当前浏览器，也能配置自己的模型
              API，独立整理与导出。
            </p>
            <dl className="feature-rows">
              <div>
                <dt>本地使用</dt>
                <dd>用自己已登录的知识星球网页读取内容，不导出 Cookie。</dd>
              </div>
              <div>
                <dt>可选同步</dt>
                <dd>配对工作台后，预览并确认选定材料。历史不会自动上传。</dd>
              </div>
            </dl>
            <Link className="text-link" to="/plugins">
              下载插件与安装说明
            </Link>
          </section>
          <section id="boundaries" className="public-section">
            <h2>权限与数据</h2>
            <p>
              官方
              MCP、独立网页登录和本地插件均只处理当前账号可访问的内容。网页登录不要求球主开启
              MCP。
            </p>
            <p>
              模型 API
              需要自己配置，可能计费；所选文本会发送到该服务。团队分享、模型加工与插件同步都保留明确的确认步骤。
            </p>
            <p className="intro-note">
              当前没有 OCR、音视频转写或外部知识系统自动写入。
              <a
                className="text-link"
                href={`${brand.repository}/blob/main/docs/features.md`}
              >
                完整功能说明
              </a>
            </p>
          </section>
          <div className="public-account">
            <Link className="button" to="/register">
              创建工作台账号
            </Link>
            <Link className="text-link" to="/recovery">
              已有账号需要恢复？
            </Link>
          </div>
        </main>
      </div>
      <PublicFooter />
    </div>
  );
}
export function PluginsPage(props: AppearanceProps) {
  const release = `${brand.repository}/releases/download/v${brand.version}`;
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main-content">
        跳到内容
      </a>
      <PublicHeader {...props} />
      <main id="main-content" className="public-main plugins-main">
        <section className="public-intro">
          <p className="intro-label">本地版 {brand.version}</p>
          <h1>安装集见浏览器插件</h1>
          <p>
            采集、阅读、整理和导出可以在浏览器里独立完成，不需要工作台账号。模型加工和同步都是可选步骤。
          </p>
        </section>
        <div className="download-table" role="table" aria-label="插件下载">
          <div className="download-table-head" role="row">
            <span role="columnheader">浏览器</span>
            <span role="columnheader">安装要求</span>
            <span role="columnheader">发行文件</span>
          </div>
          {(["chrome", "edge"] as const).map((browser) => (
            <div className="download-table-row" role="row" key={browser}>
              <strong role="cell">
                {browser === "chrome" ? "Chrome" : "Microsoft Edge"}
              </strong>
              <span role="cell">桌面版 120 或更高</span>
              <span role="cell">
                <a
                  className="button"
                  href={`${release}/jijian-${browser}-v${brand.version}.zip`}
                >
                  下载 {browser === "chrome" ? "Chrome" : "Edge"} 插件
                </a>
              </span>
            </div>
          ))}
        </div>
        <p className="intro-note">目前通过开发者模式安装，尚未上架扩展商店。</p>
        <section className="public-section install-section">
          <h2>安装步骤</h2>
          <ol>
            <li>
              <strong>下载并解压。</strong> 保存到固定目录，确认目录内有{" "}
              <code>manifest.json</code>。
            </li>
            <li>
              <strong>打开扩展管理。</strong> Chrome 输入{" "}
              <code>chrome://extensions</code>，Edge 输入{" "}
              <code>edge://extensions</code>，开启「开发者模式」。
            </li>
            <li>
              <strong>加载扩展。</strong>{" "}
              点击「加载已解压的扩展」并选择该目录。固定工具栏图标后，点击打开侧栏。
            </li>
          </ol>
          <p>
            也可使用 <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>J</kbd>
            。完整扩展页面用于阅读、选材、加工和导出。
          </p>
        </section>
        <section className="public-section">
          <h2>首次使用与更新</h2>
          <p>
            先打开知识星球并登录，再按提示授权来源，选一小批范围采集。模型设置可以稍后再配。
          </p>
          <p>
            更新前先导出本机备份，再在原目录覆盖发行文件并重新加载扩展，不先卸载。跨浏览器迁移使用备份恢复；清除浏览器数据可能删除本地资料。
          </p>
          <a
            className="text-link"
            href={`${brand.repository}/blob/main/docs/plugin-install.md`}
          >
            安装、更新与恢复说明
          </a>
        </section>
        <section className="public-section">
          <h2>哪些数据会离开本机</h2>
          <dl className="feature-rows">
            <div>
              <dt>读取来源</dt>
              <dd>请求你授权的知识星球域名。</dd>
            </div>
            <div>
              <dt>模型加工</dt>
              <dd>将所选文本发送到你配置的 API，可能计费。</dd>
            </div>
            <div>
              <dt>同步工作台</dt>
              <dd>配对后，只有预览并确认的材料才会上传。</dd>
            </div>
          </dl>
        </section>
        <div className="download-meta">
          <a className="text-link" href={`${release}/SHA256SUMS`}>
            SHA-256 校验值
          </a>
          <a
            className="text-link"
            href={`${brand.repository}/releases/tag/v${brand.version}`}
          >
            发行说明
          </a>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
