import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as safeFetch } from "undici";
type Address = { address: string; family: number };
export function pinnedLookup(addresses: Address[]) {
  return (_host: string, opts: any, cb: any) => {
    if (opts?.all) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  };
}
const dnsCache = new Map<string, { until: number; addresses: Address[] }>();
function fakeAddress(ip: string) {
  return /^198\.(?:18|19)\./.test(ip);
}
async function trustedDns(host: string): Promise<Address[]> {
  const cached = dnsCache.get(host);
  if (cached && cached.until > Date.now()) return cached.addresses;
  // The bootstrap address and TLS hostname are fixed, not selected by a user or
  // a poisoned system resolver. The DoH request includes no API credential.
  const agent = new Agent({
    connect: { lookup: pinnedLookup([{ address: "1.1.1.1", family: 4 }]) },
  });
  try {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", host);
    url.searchParams.set("type", "A");
    const r = await safeFetch(url, {
      headers: { accept: "application/dns-json" },
      dispatcher: agent,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("trusted_dns_http");
    const text = await r.text();
    if (text.length > 65536) throw new Error("trusted_dns_response");
    const d = JSON.parse(text);
    if (d.Status !== 0) throw new Error("trusted_dns_status");
    const answers = (d.Answer ?? []).filter((a: any) => a.type === 1),
      addresses = answers.map((a: any) => ({ address: a.data, family: 4 }));
    if (
      !addresses.length ||
      addresses.some((a: Address) => !isPublicAddress(a.address))
    )
      throw new Error("trusted_dns_non_public");
    const ttl = Math.max(
      5,
      Math.min(60, ...answers.map((a: any) => Number(a.TTL) || 5)),
    );
    if (dnsCache.size >= 200) dnsCache.delete(dnsCache.keys().next().value!);
    dnsCache.set(host, { until: Date.now() + ttl * 1000, addresses });
    return addresses;
  } catch {
    throw Object.assign(
      new Error(
        "本机 DNS 返回代理 fake-IP，但受信公网 DNS 核验未成功；请检查代理/DNS 后重试，未向模型发送请求",
      ),
      { code: "dns_verification_failed", statusCode: 400 },
    );
  } finally {
    await agent.close();
  }
}
export async function resolvePublicDestination(
  host: string,
  systemLookup: (host: string) => Promise<Address[]> = (host) =>
    lookup(host, { all: true, verbatim: true }),
  doh: (host: string) => Promise<Address[]> = trustedDns,
) {
  if (isIP(host) && !isPublicAddress(host))
    throw Object.assign(new Error("目标地址属于私网或保留地址"), {
      code: "private_network_denied",
      statusCode: 400,
    });
  const system = await systemLookup(host);
  let addresses = system,
    mode = "system-pinned";
  if (
    system.length &&
    system.every((a) => fakeAddress(a.address)) &&
    !isIP(host)
  ) {
    addresses = await doh(host);
    mode = "trusted-doh-fake-ip";
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw Object.assign(new Error("目标解析到私网、保留地址或不可访问地址"), {
      code: "private_network_denied",
      statusCode: 400,
    });
  return { addresses, mode };
}

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && [0, 2].includes(c)) ||
          (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Conservative native global unicast only. Special protocol/tunnel ranges are
  // not model destinations even where IANA lists narrower anycast exceptions.
  if (isIP(ip) === 6) {
    const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    const [first, second] = normalized
      .split(":")
      .map((part) => Number.parseInt(part || "0", 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      first !== 0x2002 &&
      !(first === 0x3fff && second <= 0xfff)
    );
  }
  return false;
}
export function providerURL(base: string): URL {
  const u = new URL(base);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
    throw Object.assign(
      new Error("模型地址必须是没有凭据或参数的 HTTPS 地址"),
      { code: "unsafe_provider_url", statusCode: 400 },
    );
  return u;
}
export async function publicRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
  maxBytes = 8 * 1024 * 1024,
): Promise<{ status: number; headers: Headers; text: string; bytes: Buffer }> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password)
    throw Object.assign(new Error("unsafe_destination"), {
      code: "unsafe_provider_url",
      statusCode: 400,
    });
  const resolved = await resolvePublicDestination(
    u.hostname.replace(/^\[|\]$/g, ""),
  );
  const agent = new Agent({
    connect: {
      lookup: pinnedLookup(resolved.addresses),
    },
    headersTimeout: 60000,
    bodyTimeout: 60000,
  });
  try {
    const response = await safeFetch(url, {
      ...init,
      redirect: "manual",
      dispatcher: agent,
      signal: init.signal ?? AbortSignal.timeout(90000),
    });
    if (response.status >= 300 && response.status < 400)
      throw Object.assign(new Error("不跟随重定向；请填写模型服务实际地址"), {
        code: "redirect_denied",
        statusCode: 400,
      });
    const reader = response.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("response_too_large");
        }
        chunks.push(value);
      }
    const bytes = Buffer.concat(chunks);
    return {
      status: response.status,
      headers: new Headers([...response.headers]),
      text: bytes.toString("utf8"),
      bytes,
    };
  } finally {
    await agent.close();
  }
}
