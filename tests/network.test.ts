import test from "node:test";
import assert from "node:assert/strict";
import {
  isPublicAddress,
  pinnedLookup,
  resolvePublicDestination,
} from "../server/net.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/index.js";
import {
  providerCall,
  providerModels,
  type Provider,
} from "../server/provider.js";
const p: Provider = {
  id: "test",
  label: "隔离MiMo协议",
  user_id: "u",
  base_url: "https://api.xiaomimimo.com/v1",
  protocol: "responses",
  model: "mimo-v2.6-flash",
  models: [],
  secret: "",
};
test("special IPv6 forms and tunnel destinations stay blocked without rejecting adjacent public IPv4 blocks", () => {
  for (const ip of [
    "2001:db8::1",
    "2001:0DB8:0:0:0:0:0:1",
    "2001::1",
    "2001:1ff::1",
    "2002:7f00:1::1",
    "3fff::1",
    "3fff:fff::1",
    "::ffff:127.0.0.1",
    "192.88.99.2",
    "203.0.113.1",
    "198.51.100.1",
    "192.0.2.1",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of [
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "192.0.3.1",
    "198.51.101.1",
    "203.0.114.1",
  ])
    assert.equal(isPublicAddress(ip), true, ip);
});
test("Node24 pinned resolver honors both lookup callback contracts including all:true", () => {
  const addresses = [
    { address: "8.8.8.8", family: 4 },
    { address: "1.1.1.1", family: 4 },
  ];
  let called: any[] = [];
  pinnedLookup(addresses)(
    "ignored",
    { all: true },
    (...args: any[]) => (called = args),
  );
  assert.deepEqual(called, [null, addresses]);
  pinnedLookup(addresses)("ignored", {}, (...args: any[]) => (called = args));
  assert.deepEqual(called, [null, "8.8.8.8", 4]);
});
test("fake-IP uses separately verified public DNS; loopback/private/mixed addresses never bypass or fall back", async () => {
  let calls = 0;
  const doh = async () => {
    calls++;
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const out = await resolvePublicDestination(
    "provider.example",
    async () => [{ address: "198.18.0.117", family: 4 }],
    doh,
  );
  assert.equal(out.mode, "trusted-doh-fake-ip");
  assert.equal(calls, 1);
  assert.equal(out.addresses[0].address, "8.8.8.8");
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "fc00::1",
  ])
    await assert.rejects(
      resolvePublicDestination(
        "provider.example",
        async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        doh,
      ),
      { code: "private_network_denied" },
    );
  await assert.rejects(
    resolvePublicDestination(
      "provider.example",
      async () => [
        { address: "198.18.0.1", family: 4 },
        { address: "10.0.0.2", family: 4 },
      ],
      doh,
    ),
    { code: "private_network_denied" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    resolvePublicDestination("198.18.0.1", async () => [], doh),
    { code: "private_network_denied" },
  );
  await assert.rejects(
    resolvePublicDestination(
      "provider.example",
      async () => [{ address: "198.18.0.1", family: 4 }],
      async () => [{ address: "192.168.1.1", family: 4 }],
    ),
    { code: "private_network_denied" },
  );
});
test("MiMo uses native api-key header; small verification disables reasoning only for supported MiMo Responses", async () => {
  const sent: any[] = [];
  const request: any = async (url: string, init: any) => {
    sent.push({ url, init });
    const text = JSON.stringify(
      url.endsWith("/models")
        ? { data: [{ id: "mimo-v2.6-flash" }] }
        : {
            status: "completed",
            model: p.model,
            output: [{ content: [{ type: "output_text", text: "连接成功" }] }],
            usage: { total_tokens: 12 },
          },
    );
    return {
      status: 200,
      headers: new Headers(),
      text,
      bytes: Buffer.from(text),
    };
  };
  assert.deepEqual(await providerModels(p, "fixture-key", request), [p.model]);
  const reply = await providerCall(
    p,
    "fixture-key",
    "brief",
    "connection only",
    256,
    p.model,
    request,
    true,
  );
  assert.equal(reply.text, "连接成功");
  assert.equal(reply.truncated, false);
  assert.equal(sent[0].init.headers["api-key"], "fixture-key");
  assert.equal(sent[1].init.headers["api-key"], "fixture-key");
  assert.deepEqual(JSON.parse(sent[1].init.body).reasoning, { effort: "none" });
  await providerCall(
    { ...p, base_url: "https://other.example/v1" },
    "fixture-key",
    "s",
    "i",
    256,
    p.model,
    request,
    true,
  );
  assert.equal(sent[2].init.headers.Authorization, "Bearer fixture-key");
  assert.equal(JSON.parse(sent[2].init.body).reasoning, undefined);
});

test("discovery requires no model/name/save and stored Key cannot be rerouted to a new destination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-provider-discovery-"));
  let calls = 0;
  const fixture: any = async () => {
    calls++;
    const text = JSON.stringify({ data: [{ id: "fixture-model" }] });
    return {
      status: 200,
      headers: new Headers(),
      text,
      bytes: Buffer.from(text),
    };
  };
  const { app, store } = await createApp({
    dataDir: dir,
    worker: false,
    runtime: { request: fixture },
  });
  try {
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "discovery@example.test",
        name: "隔离",
        password: "Provider-discovery-password-42!",
      },
    });
    assert.equal(registered.statusCode, 201);
    const auth = registered.json(),
      headers = {
        cookie: registered.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; "),
        "x-csrf-token": auth.csrf,
      };
    const discovery = await app.inject({
      method: "POST",
      url: "/api/providers/discover",
      headers,
      payload: {
        base_url: "https://provider.example/v1",
        protocol: "responses",
        api_key: "fixture-private-key",
      },
    });
    assert.equal(discovery.statusCode, 200);
    assert.deepEqual(discovery.json().models, ["fixture-model"]);
    assert.equal(discovery.json().saved, false);
    assert.equal(store.list("provider").length, 0);
    assert(!discovery.body.includes("fixture-private-key"));
    const saved = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers,
      payload: {
        base_url: "https://provider.example/v1",
        protocol: "responses",
        api_key: "fixture-private-key",
        label: "隔离配置",
        model: "fixture-model",
      },
    });
    assert.equal(saved.statusCode, 200);
    const id = saved.json().id;
    const existing = await app.inject({
      method: "POST",
      url: "/api/providers/discover",
      headers,
      payload: {
        provider_id: id,
        base_url: "https://provider.example/v1",
        protocol: "responses",
      },
    });
    assert.equal(existing.statusCode, 200);
    for (const route of ["discover", "patch"]) {
      const changed = await app.inject({
        method: route === "discover" ? "POST" : "PATCH",
        url:
          route === "discover"
            ? "/api/providers/discover"
            : "/api/providers/" + id,
        headers,
        payload: {
          provider_id: id,
          base_url: "https://other.example/v1",
          protocol: "responses",
        },
      });
      assert.equal(changed.statusCode, 400);
      assert.equal(changed.json().error.code, "key_destination_changed");
    }
    assert.equal(calls, 2);
    assert.equal(
      store.get("provider", id).base_url,
      "https://provider.example/v1",
    );
  } finally {
    await app.close();
    const target = resolve(dir);
    assert(
      target.startsWith(resolve(tmpdir()) + "\\") ||
        target.startsWith(resolve(tmpdir()) + "/"),
    );
    rmSync(target, { recursive: true, force: true });
  }
});
