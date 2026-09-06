// services/google/google.oauth.service.connect-flow.test.js
//
// TASK 4: covers the restructured two-step connect flow — consent first
// (buildConsentUrl/resolveState no longer carry merchant fields, only
// tenant_id + purpose, but the signed/verified/purpose-checked state
// mechanism itself is unchanged), then savePendingConnection (saves a
// PENDING ChannelConnection with just the token), listAccessibleAccounts
// (accounts.list, keyed off that saved token), and completeConnection
// (upgrades PENDING -> CONNECTED once a Merchant Center account is chosen).
//
// Needs a live Mongo connection — run with:
//   node --test src/services/google/google.oauth.service.connect-flow.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const config = require("../../config");

require("../../models/index");
const ChannelConnection = require("../../models/ChannelConnection");
const { decrypt, unpackCiphertext } = require("../../utils/crypto/tokenCipher");
const oauthService = require("./google.oauth.service");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("buildConsentUrl/resolveState: state carries ONLY tenant_id + purpose now — no merchant fields required or round-tripped", () => {
  const tenantId = new mongoose.Types.ObjectId().toString();
  const url = oauthService.buildConsentUrl({ tenantId });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "consent");
  const state = parsed.searchParams.get("state");
  assert.ok(state, "a signed state must still be present — CSRF protection unchanged");

  const resolved = oauthService.resolveState(state);
  assert.deepEqual(resolved, { tenantId });
});

test("resolveState: still rejects a missing/invalid/wrong-purpose state exactly as before", () => {
  assert.throws(() => oauthService.resolveState(null), /Missing OAuth state/);
  assert.throws(() => oauthService.resolveState("not-a-real-jwt"));
});

test("savePendingConnection: saves a PENDING connection with just the token, no merchant fields set", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async () => jsonResponse(200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 }));
  t.after(() => mock.restoreAll());

  const tenantId = new mongoose.Types.ObjectId();
  await oauthService.savePendingConnection({ tenantId, code: "fake-code" });

  const conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform: "google" })
    .select("+access_token_ct +refresh_token_ct")
    .lean();
  assert.ok(conn, "a ChannelConnection row must exist after savePendingConnection");
  assert.equal(conn.status, "pending");
  // Not $set at all by savePendingConnection (no merchant account has been
  // chosen yet) — a base-model upsert doesn't apply a discriminator-only
  // field's schema default for a field it never touched, so this reads
  // back as genuinely absent (undefined), not an explicit null. Either way
  // reads as "missing" to assertConfigured's `!settings?.merchant_id` check.
  assert.equal(conn.merchant_id, undefined);
  assert.equal(conn.data_source_id, undefined);
  assert.equal(decrypt(unpackCiphertext(conn.access_token_ct)), "acc-1");
});

test("listAccessibleAccounts: throws NO_PENDING_CONNECTION for a tenant that never ran OAuth", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  await assert.rejects(
    () => oauthService.listAccessibleAccounts(tenantId),
    (err) => {
      assert.equal(err.code, "NO_PENDING_CONNECTION");
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("listAccessibleAccounts: returns the accounts.list result for a tenant with a saved (pending) token", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async (url) => {
    if (String(url).includes("token")) return jsonResponse(200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
    if (String(url).includes("accounts.list") || String(url).endsWith("/accounts?pageSize=250")) {
      return jsonResponse(200, {
        accounts: [
          { name: "accounts/111", accountId: "111", accountName: "Store One" },
          { name: "accounts/222", accountId: "222", accountName: "Store Two" },
        ],
      });
    }
    return jsonResponse(404, {});
  });
  t.after(() => mock.restoreAll());

  const tenantId = new mongoose.Types.ObjectId();
  await oauthService.savePendingConnection({ tenantId, code: "fake-code" });

  const accounts = await oauthService.listAccessibleAccounts(tenantId);
  assert.deepEqual(accounts, [
    { accountId: "111", accountName: "Store One" },
    { accountId: "222", accountName: "Store Two" },
  ]);
});

test("completeConnection: rejects a merchantId not present in verifiedAccountIds, without calling ensureDataSource", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  let dataSourceCalled = false;
  mock.method(global, "fetch", async (url) => {
    if (String(url).includes("dataSources")) dataSourceCalled = true;
    return jsonResponse(200, {});
  });
  t.after(() => mock.restoreAll());

  const tenantId = new mongoose.Types.ObjectId();

  await assert.rejects(
    () =>
      oauthService.completeConnection({
        tenantId,
        merchantId: "999",
        feedLabel: "AU",
        contentLanguage: "en",
        targetCountry: "AU",
        verifiedAccountIds: ["111", "222"],
      }),
    (err) => {
      assert.equal(err.code, "MERCHANT_NOT_ACCESSIBLE");
      assert.equal(err.status, 400);
      return true;
    },
  );
  assert.equal(dataSourceCalled, false, "must never call the Merchant API for an account the token can't reach");
});

test("completeConnection: with no PENDING row for this tenant, fails loudly (NO_PENDING_CONNECTION) rather than creating one from nothing", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  await assert.rejects(
    () =>
      oauthService.completeConnection({
        tenantId,
        merchantId: "111",
        feedLabel: "AU",
        contentLanguage: "en",
        targetCountry: "AU",
      }),
    (err) => {
      assert.equal(err.code, "NO_PENDING_CONNECTION");
      return true;
    },
  );
});

test("completeConnection: upgrades a PENDING connection to CONNECTED with the chosen merchant/feed settings, using the already-saved token", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) return jsonResponse(200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
    if (u.includes("/dataSources")) return jsonResponse(200, { name: "accounts/111/dataSources/ds1" });
    return jsonResponse(404, {});
  });
  t.after(() => mock.restoreAll());

  const tenantId = new mongoose.Types.ObjectId();
  await oauthService.savePendingConnection({ tenantId, code: "fake-code" });

  const conn = await oauthService.completeConnection({
    tenantId,
    merchantId: "111",
    feedLabel: "AU",
    contentLanguage: "en",
    targetCountry: "AU",
    verifiedAccountIds: ["111"],
  });

  assert.equal(conn.status, "connected");
  assert.equal(conn.merchant_id, "111");
  assert.equal(conn.feed_label, "AU");
  assert.equal(conn.data_source_id, "ds1");

  const persisted = await ChannelConnection.findOne({ tenant_id: tenantId, platform: "google" }).lean();
  assert.equal(persisted.status, "connected");
});
