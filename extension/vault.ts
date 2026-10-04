import { base64Bytes, bytesBase64 } from "./browser-core";
const VAULT = "xingjian-vault-v1",
  SESSION = "xingjian-secrets";
interface EncryptedVault {
  version: 1;
  salt: string;
  iv: string;
  cipher: string;
  iterations: number;
}
async function keyFor(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  if (password.length < 8) throw new Error("记住密钥时，解锁口令至少 8 位。");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new Uint8Array(salt), iterations, hash: "SHA-256" },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptSecrets(
  secrets: Record<string, string>,
  password: string,
): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    iterations = 310000;
  const key = await keyFor(password, salt, iterations);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(secrets)),
  );
  return {
    version: 1,
    salt: bytesBase64(salt),
    iv: bytesBase64(iv),
    cipher: bytesBase64(new Uint8Array(encrypted)),
    iterations,
  };
}
export async function decryptSecrets(
  vault: EncryptedVault,
  password: string,
): Promise<Record<string, string>> {
  if (vault.version !== 1 || vault.iterations !== 310000)
    throw new Error("密钥保险箱格式不兼容。");
  try {
    const key = await keyFor(
      password,
      base64Bytes(vault.salt),
      vault.iterations,
    );
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(base64Bytes(vault.iv)) },
      key,
      new Uint8Array(base64Bytes(vault.cipher)),
    );
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.values(data).some((v) => typeof v !== "string")
    )
      throw new Error("Invalid");
    return data;
  } catch {
    throw new Error("解锁失败：口令错误或保险箱已损坏。");
  }
}
async function sessionValues(): Promise<Record<string, string>> {
  return (
    ((await chrome.storage.session.get(SESSION))[SESSION] as Record<
      string,
      string
    >) ?? {}
  );
}
export async function secret(id: string): Promise<string> {
  return (await sessionValues())[id] ?? "";
}
export async function setSecret(
  id: string,
  value: string,
  remember = false,
  password = "",
): Promise<void> {
  if (remember) {
    const saved = (await chrome.storage.local.get(VAULT))[VAULT] as
      | EncryptedVault
      | undefined;
    const secrets = saved ? await decryptSecrets(saved, password) : {};
    secrets[id] = value;
    await chrome.storage.local.set({
      [VAULT]: await encryptSecrets(secrets, password),
    });
  }
  const values = await sessionValues();
  if (value) values[id] = value;
  else delete values[id];
  await chrome.storage.session.set({ [SESSION]: values });
}
export async function deleteSecret(id: string, password = ""): Promise<void> {
  const saved = (await chrome.storage.local.get(VAULT))[VAULT] as
    | EncryptedVault
    | undefined;
  if (saved) {
    if (!password)
      throw new Error("删除持久密钥需要解锁口令；也可锁定后移除整个保险箱。");
    const values = await decryptSecrets(saved, password);
    delete values[id];
    await chrome.storage.local.set({
      [VAULT]: await encryptSecrets(values, password),
    });
  }
  await setSecret(id, "");
}
export async function unlock(password: string): Promise<number> {
  const saved = (await chrome.storage.local.get(VAULT))[VAULT] as
    | EncryptedVault
    | undefined;
  if (!saved) throw new Error("尚未建立持久密钥保险箱。");
  const values = await decryptSecrets(saved, password);
  const session = await sessionValues();
  await chrome.storage.session.set({ [SESSION]: { ...session, ...values } });
  return Object.keys(values).length;
}
export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION);
}
export async function eraseVault(): Promise<void> {
  await chrome.storage.local.remove(VAULT);
  await lock();
}
