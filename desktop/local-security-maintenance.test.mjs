import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_SECURITY_MAINTENANCE_TTL_MS,
  applyLocalSecurityMaintenanceEnv,
  normalizeLocalSecurityMaintenanceState,
} from "./local-security-maintenance.mjs";

test("maintenance is disabled by default and strips maintenance env", () => {
  const env = applyLocalSecurityMaintenanceEnv({
    KEEP: "yes",
    FORGELINK_LOCAL_SECURITY_MAINTENANCE: "1",
    FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT: "9999999999999",
  }, {}, 1000);
  assert.equal(env.KEEP, "yes");
  assert.equal(env.FORGELINK_LOCAL_SECURITY_MAINTENANCE, undefined);
  assert.equal(env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT, undefined);
});

test("active maintenance emits bounded environment state", () => {
  const now = 1_000;
  const expiresAt = now + LOCAL_SECURITY_MAINTENANCE_TTL_MS;
  const state = normalizeLocalSecurityMaintenanceState({ enabled: true, expiresAt }, now);
  assert.equal(state.enabled, true);
  assert.equal(state.remainingMs, LOCAL_SECURITY_MAINTENANCE_TTL_MS);
  const env = applyLocalSecurityMaintenanceEnv({ KEEP: "yes" }, state, now);
  assert.equal(env.FORGELINK_LOCAL_SECURITY_MAINTENANCE, "1");
  assert.equal(env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT, String(expiresAt));
});

test("expired maintenance fails closed", () => {
  const state = normalizeLocalSecurityMaintenanceState({ enabled: true, expiresAt: 999 }, 1000);
  assert.deepEqual(state, { enabled: false, expiresAt: null, remainingMs: 0 });
  const env = applyLocalSecurityMaintenanceEnv({}, { enabled: true, expiresAt: 999 }, 1000);
  assert.equal(env.FORGELINK_LOCAL_SECURITY_MAINTENANCE, undefined);
  assert.equal(env.FORGELINK_LOCAL_SECURITY_MAINTENANCE_EXPIRES_AT, undefined);
});

test("supports custom maintenance durations: 15m, 30m, 1h, 5h, 15h, 1day", async () => {
  const { parseMaintenanceDurationMs, formatMaintenanceDurationLabel, LOCAL_SECURITY_MAINTENANCE_DURATIONS } = await import("./local-security-maintenance.mjs");
  assert.equal(parseMaintenanceDurationMs("15m"), 15 * 60_000);
  assert.equal(parseMaintenanceDurationMs("30m"), 30 * 60_000);
  assert.equal(parseMaintenanceDurationMs("1h"), 60 * 60_000);
  assert.equal(parseMaintenanceDurationMs("5h"), 5 * 3600_000);
  assert.equal(parseMaintenanceDurationMs("15h"), 15 * 3600_000);
  assert.equal(parseMaintenanceDurationMs("1day"), 24 * 3600_000);
  assert.equal(parseMaintenanceDurationMs("1d"), 24 * 3600_000);
  assert.equal(parseMaintenanceDurationMs("24h"), 24 * 3600_000);

  assert.equal(formatMaintenanceDurationLabel("15m"), "15 minutes");
  assert.equal(formatMaintenanceDurationLabel("30m"), "30 minutes");
  assert.equal(formatMaintenanceDurationLabel("1h"), "1 hour");
  assert.equal(formatMaintenanceDurationLabel("5h"), "5 hours");
  assert.equal(formatMaintenanceDurationLabel("15h"), "15 hours");
  assert.equal(formatMaintenanceDurationLabel("1day"), "1 day");

  const state1h = normalizeLocalSecurityMaintenanceState({ enabled: true, expiresAt: 10_000 + 3600_000, durationMs: 3600_000 }, 10_000);
  assert.equal(state1h.enabled, true);
  assert.equal(state1h.durationMs, 3600_000);
  assert.equal(state1h.remainingMs, 3600_000);
});

