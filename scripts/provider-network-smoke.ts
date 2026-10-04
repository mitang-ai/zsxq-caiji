import { resolvePublicDestination, publicRequest } from "../server/net.js";
import { mkdirSync, writeFileSync } from "node:fs";

// Fixed, anonymous connectivity proof only. No stored Provider or user data is read.
const host = "api.xiaomimimo.com";
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  kind: "live-no-credentials-connectivity",
  host,
  key_sent: false,
  materials_sent: false,
  model_inference_verified: false,
};
try {
  const destination = await resolvePublicDestination(host);
  report.dns_mode = destination.mode;
  report.verified_public_addresses = destination.addresses.length;
  const response = await publicRequest(`https://${host}/v1/models`);
  report.status = response.status;
  report.result =
    response.status === 401
      ? "unauthenticated-interface-reached"
      : "unexpected-status";
  if (response.status !== 401) process.exitCode = 1;
} catch (error: any) {
  report.error = error.code ?? "transport-error";
  process.exitCode = 1;
} finally {
  mkdirSync("test-output", { recursive: true });
  writeFileSync(
    "test-output/provider-network-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
