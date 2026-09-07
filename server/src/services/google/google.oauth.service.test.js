// services/google/google.oauth.service.test.js
//
// Token refresh: proactive (near-expiry) refresh, persistence back to
// ChannelConnection, and safety under a concurrent-refresh race (two jobs
// asking for a valid token around the same moment must not both hit
// Google's token endpoint and clobber each other — see
// google.oauth.service.js#refreshAccessToken's own comment).
//
// Needs a live Mongo connection — run with:
//   node --test src/services/google/google.oauth.service.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const ChannelConnection = require("../../models/ChannelConnection");
const { encrypt, decrypt, packCiphertext, unpackCiphertext } = require("../../utils/crypto/tokenCipher");
const oauthService = require("./google.oauth.service");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function makeConnection({ accessTokenExpired = false } = {}) {
  const tenantId = new mongoose.Types.ObjectId();
  const encAccess = encrypt("stale-access-token");
  const encRefresh = encrypt(`refresh-${crypto.randomUUID()}`);
  await ChannelConnection.collection.insertOne({
    tenant_id: tenantId,
    platform: "google",
    status: "connected",
    access_token_ct: packCiphertext(encAccess),
    refresh_token_ct: packCiphertext(encRefresh),
    token_expires_at: accessTokenExpired ? new Date(Date.now() - 10_000) : new Date(Date.now() + 3600_000),
    merchant_id: "merchant123",
    consecutive_failures: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return ChannelConnection.findOne({ tenant_id: tenantId }).select("+access_token_ct +refresh_token_ct").lean();
}

test("getValidAccessToken: returns the cached token without calling fetch when not near expiry", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  let fetchCalls = 0;
  mock.method(global, "fetch", async () => {
    fetchCalls++;
    return jsonResponse(200, { access_token: "should-not-be-used", expires_in: 3600 });
  });

  const connection = await makeConnection({ accessTokenExpired: false });
  const token = await oauthService.getValidAccessToken(connection);

  assert.equal(token, "stale-access-token");
  assert.equal(fetchCalls, 0, "a non-expiring cached token must never trigger a refresh call");
});

test("refreshAccessToken: persists the new access token and expiry back to ChannelConnection", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async () => jsonResponse(200, { access_token: "fresh-access-token", expires_in: 1800 }));

  const connection = await makeConnection({ accessTokenExpired: true });
  const refreshToken = decrypt(unpackCiphertext(connection.refresh_token_ct));

  const { accessToken } = await oauthService.refreshAccessToken(connection.tenant_id, refreshToken);
  assert.equal(accessToken, "fresh-access-token");

  const updated = await ChannelConnection.findOne({ tenant_id: connection.tenant_id }).select("+access_token_ct").lean();
  const persisted = decrypt(unpackCiphertext(updated.access_token_ct));
  assert.equal(persisted, "fresh-access-token");
  assert.ok(updated.token_expires_at.getTime() > Date.now() + 1700_000, "token_expires_at must reflect the new expires_in");
});

test("getValidAccessToken: an expired cached token triggers exactly one refresh call and returns the new token", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  let fetchCalls = 0;
  mock.method(global, "fetch", async () => {
    fetchCalls++;
    return jsonResponse(200, { access_token: "refreshed-token", expires_in: 3600 });
  });

  const connection = await makeConnection({ accessTokenExpired: true });
  const token = await oauthService.getValidAccessToken(connection);

  assert.equal(token, "refreshed-token");
  assert.equal(fetchCalls, 1);
});

test("refreshAccessToken: a concurrent-refresh race for the SAME tenant only hits the token endpoint once", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  let fetchCalls = 0;
  mock.method(global, "fetch", async () => {
    fetchCalls++;
    // A small delay so the two calls below genuinely overlap in time,
    // rather than one finishing before the other even starts.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return jsonResponse(200, { access_token: `token-${fetchCalls}`, expires_in: 3600 });
  });

  const connection = await makeConnection({ accessTokenExpired: true });
  const refreshToken = decrypt(unpackCiphertext(connection.refresh_token_ct));

  const [first, second] = await Promise.all([
    oauthService.refreshAccessToken(connection.tenant_id, refreshToken),
    oauthService.refreshAccessToken(connection.tenant_id, refreshToken),
  ]);

  assert.equal(fetchCalls, 1, "two concurrent refresh calls for the same tenant must only hit Google's token endpoint once");
  assert.equal(first.accessToken, second.accessToken, "both callers must resolve to the SAME in-flight result");

  const updated = await ChannelConnection.findOne({ tenant_id: connection.tenant_id }).select("+access_token_ct").lean();
  const persisted = decrypt(unpackCiphertext(updated.access_token_ct));
  assert.equal(persisted, first.accessToken, "the persisted token must be the one both callers actually received");
});

test("refreshAccessToken: a subsequent call after the in-flight one settles refreshes again (de-dup does not wedge forever)", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  let fetchCalls = 0;
  mock.method(global, "fetch", async () => {
    fetchCalls++;
    return jsonResponse(200, { access_token: `token-${fetchCalls}`, expires_in: 3600 });
  });

  const connection = await makeConnection({ accessTokenExpired: true });
  const refreshToken = decrypt(unpackCiphertext(connection.refresh_token_ct));

  await oauthService.refreshAccessToken(connection.tenant_id, refreshToken);
  await oauthService.refreshAccessToken(connection.tenant_id, refreshToken);

  assert.equal(fetchCalls, 2, "sequential (non-overlapping) refresh calls must each actually refresh");
});

test("google.oauth.service: a 503 token-endpoint response is thrown with .status = 503 (transport failure — counts toward the circuit breaker)", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async () => jsonResponse(503, { error: "backend_error" }));

  const connection = await makeConnection({ accessTokenExpired: true });
  const refreshToken = decrypt(unpackCiphertext(connection.refresh_token_ct));

  await assert.rejects(
    () => oauthService.refreshAccessToken(connection.tenant_id, refreshToken),
    (err) => {
      assert.equal(err.status, 503);
      return true;
    },
  );

  const circuitBreaker = require("../marketplace/circuitBreaker");
  assert.equal(circuitBreaker.isTransportOrAuthFailure({ status: 503 }), true);
  assert.equal(circuitBreaker.isTransportOrAuthFailure({ status: 400 }), false);
});
