import { unzipSync } from "fflate";
/** Reject allocation bombs before fflate inflates any selected entry. Unknown ZIP paths are never extracted. */
export function readArchive(input: Uint8Array): Record<string, Uint8Array> {
  if (input.length > 200 * 1024 * 1024)
    throw new Error("本次文件上限 200 MiB。");
  let total = 0,
    count = 0;
  return unzipSync(input, {
    filter: (entry) => {
      if (
        !["bundle.json", "local-state.json"].includes(entry.name) &&
        !/^attachments\/[a-f0-9]{64}$/.test(entry.name)
      )
        return false;
      if (
        ++count > 10002 ||
        entry.originalSize > 50 * 1024 * 1024 ||
        entry.originalSize < 0
      )
        throw new Error("ZIP 单项体积或条目数超过恢复上限。");
      total += entry.originalSize;
      if (total > 500 * 1024 * 1024)
        throw new Error("ZIP 声明解包体积超过 500 MiB。");
      return true;
    },
  });
}
export function assertNoCredentials(value: unknown): void {
  const walk = (node: unknown, depth: number) => {
    if (depth > 100) throw new Error("备份嵌套深度异常。");
    if (!node || typeof node !== "object") return;
    for (const [key, v] of Object.entries(node)) {
      if (
        /^(?:api[_-]?key|cookie|authorization|password|passphrase|credentials|token|secret|access_token|refresh_token|device_token)$/i.test(
          key,
        )
      )
        throw new Error("备份含凭据字段，拒绝写入本地资料库。");
      walk(v, depth + 1);
    }
  };
  walk(value, 0);
}
