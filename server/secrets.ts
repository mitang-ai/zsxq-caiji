import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
export function vault(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const p = join(dataDir, "master.key");
  if (!existsSync(p))
    writeFileSync(p, randomBytes(32), { mode: 0o600, flag: "wx" });
  const key = readFileSync(p);
  if (key.length !== 32) throw new Error("invalid_master_key");
  if (process.platform !== "win32") chmodSync(p, 0o600);
  return {
    encrypt(value: string | Uint8Array) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([
        iv,
        c.update(value),
        c.final(),
        c.getAuthTag(),
      ]).toString("base64");
    },
    decrypt(value: string) {
      const b = Buffer.from(value, "base64");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]);
    },
  };
}
