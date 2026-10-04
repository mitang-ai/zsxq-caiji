import type { Session } from "./types";
import { useEffect, useRef, useState } from "react";
import { download, useOperation } from "./api";
import { Button, Field, Notice, OperationNotice } from "./ui";
import {
  createQuickCredentials,
  credentialsText,
  registerQuickAccount,
  type QuickCredentials,
} from "./accountCredentials";

export function QuickAccount({
  disabled,
  onActiveChange,
  onSuccess,
}: {
  disabled: boolean;
  onActiveChange: (active: boolean) => void;
  onSuccess: (session: Session) => void;
}) {
  const [credentials, setCredentials] = useState<QuickCredentials | null>(null);
  const credentialsRef = useRef<QuickCredentials | null>(null);
  const attempted = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const [saved, setSaved] = useState(false);
  const [visible, setVisible] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const op = useOperation();
  useEffect(() => {
    if (!credentials) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [credentials]);
  async function create() {
    if (disabled || op.busy) return;
    const result = await op.run(async () => {
      const c = credentialsRef.current ?? createQuickCredentials();
      credentialsRef.current = c;
      setCredentials(c);
      onActiveChange(true);
      const retry = attempted.current;
      attempted.current = true;
      return registerQuickAccount(c, retry);
    });
    if (result) setSession(result);
  }
  async function copy() {
    if (!credentials) return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(
        credentialsText(credentials, location.origin),
      );
      setCopyNotice(
        "账密已复制，请粘贴到安全位置保存。不要发到聊天或公开文档中。",
      );
    } catch {
      setCopyNotice("复制未成功，请下载账密文件，或显示密码后手动选择保存。");
    }
  }
  function enter() {
    if (!session || !saved || !credentials) return;
    // Clear the only in-page plaintext copy before handing control to the app.
    credentialsRef.current = null;
    setCredentials(null);
    setVisible(false);
    onSuccess(session);
  }
  return (
    <section className="quick-account" aria-label="一键账号">
      {!credentials ? (
        <>
          <Button
            type="button"
            disabled={disabled}
            busy={op.busy}
            onClick={() => void create()}
          >
            一键创建账号密码
          </Button>
          <p className="field-hint">
            无需填写邮箱，自动生成账号和强密码。已有账号请使用下方登录。
          </p>
          <p className="credential-warning">
            <strong>请妥善保管账号和密码。</strong> 不要分享或上传到公开位置。
          </p>
          <OperationNotice op={op} />
        </>
      ) : (
        <>
          <h2>
            {session
              ? "账号已创建，请先保存账密"
              : op.busy
                ? "正在创建账号"
                : "创建结果需要确认"}
          </h2>
          <Notice tone="warning">
            <strong>请妥善保管账号和密码。</strong>{" "}
            页面关闭后无法再次查看这次生成的密码。自动生成的账号不是邮箱，不会收到邮件；遗失账密需联系实例管理员按恢复流程处理。
          </Notice>
          <Field label="生成的账号">
            <input
              value={credentials.email}
              readOnly
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="生成的密码">
            <input
              type={visible ? "text" : "password"}
              value={credentials.password}
              readOnly
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="form-actions">
            <Button type="button" onClick={() => setVisible(!visible)}>
              {visible ? "隐藏密码" : "显示密码"}
            </Button>
            <Button type="button" onClick={() => void copy()}>
              复制账号密码
            </Button>
            <Button
              type="button"
              onClick={() => {
                download(
                  "jijian-account.txt",
                  credentialsText(credentials, location.origin),
                  "text/plain;charset=utf-8",
                );
                setCopyNotice(
                  "账密文件已交给浏览器下载，请检查下载结果并安全保存。",
                );
              }}
            >
              下载账密文件
            </Button>
          </div>
          <p className="field-hint">
            下载文件包含明文密码，请存入密码管理器或加密位置。
          </p>
          {copyNotice && (
            <p className="field-hint" role="status">
              {copyNotice}
            </p>
          )}
          <OperationNotice op={op} />
          {!session && !op.busy && (
            <>
              <p className="field-hint">
                请保留这组账密，检查网络后重试。重试使用同一组账密核验，不会另外生成账号。
              </p>
              <Button type="button" onClick={() => void create()}>
                重试创建或登录
              </Button>
            </>
          )}
          {session && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                我已妥善保存账号和密码
              </label>
              <Button type="button" primary disabled={!saved} onClick={enter}>
                进入工作台
              </Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
