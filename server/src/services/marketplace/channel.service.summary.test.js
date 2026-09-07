// services/marketplace/channel.service.summary.test.js
//
// Catalogue redesign — listChannelsForTenant now also returns
// last_synced_at (real per-platform max MarketplaceListing.synced_at, not
// the connection-level "last successful API call" health.last_success_at
// already returned), needs_attention_count (listings in sync_status
// error/price_locked), and health_status ("healthy" | "needs_attention",
// folding in both the listing-level count AND ChannelConnection's own
// consecutive_failures/degraded state — a channel with zero bad listings
// but a tripped circuit breaker must still read "needs_attention").
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/channel.service.summary.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const config = require("../../config");

require("../../models/index");
const MarketplaceListing = require("../../models/MarketplaceListing");
const ChannelConnection = require("../../models/ChannelConnection");
const registry = require("./registry");
// Real ebay adapter — its manifest/discriminator already exist regardless of
// registration; register() is what makes it show up in listChannelsForTenant's
// output. google is already required by other test files loaded in the same
// run in some suites, but this file must be independently runnable
// (`node --test` isolates one process per file), so register both directly,
// same pattern as channel.service.storefront.test.js.
const ebayAdapter = require("./adapters/ebay.adapter");
const googleAdapter = require("./adapters/google.adapter");
registry.register(ebayAdapter);
registry.register(googleAdapter);

const { listChannelsForTenant } = require("./channel.service");
const { LISTING_SYNC_STATUS, LISTING_STATE } = require("../../constants/marketplace.constants");
const { CHANNEL_CONNECTION_STATUS } = require("../../constants/channel.constants");

function makeListing(tenantId, overrides = {}) {
  return {
    tenant_id: tenantId,
    product: new mongoose.Types.ObjectId(),
    platform: "ebay",
    state: LISTING_STATE.ACTIVE,
    sync_status: LISTING_SYNC_STATUS.SYNCED,
    synced_at: null,
    ...overrides,
  };
}

test("listChannelsForTenant: last_synced_at is the real max MarketplaceListing.synced_at across every sync_status bucket, not health.last_success_at", async (t) => {
  await mongoose.connect(config.mongoUri);
  const tenantId = new mongoose.Types.ObjectId();
  t.after(async () => {
    await MarketplaceListing.deleteMany({ tenant_id: tenantId });
    await mongoose.disconnect();
  });

  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-06-01T00:00:00Z");

  await MarketplaceListing.create([
    makeListing(tenantId, { synced_at: older, sync_status: LISTING_SYNC_STATUS.SYNCED }),
    // The most recent activity is an ERROR row, not a synced one —
    // last_synced_at must still pick it up (max across ALL buckets).
    makeListing(tenantId, { synced_at: newer, sync_status: LISTING_SYNC_STATUS.ERROR }),
  ]);

  const channels = await listChannelsForTenant(tenantId);
  const ebay = channels.find((c) => c.key === "ebay");

  assert.equal(new Date(ebay.last_synced_at).getTime(), newer.getTime());
});

test("listChannelsForTenant: last_synced_at is null for a channel with no synced listings at all", async (t) => {
  await mongoose.connect(config.mongoUri);
  const tenantId = new mongoose.Types.ObjectId();
  t.after(async () => {
    await mongoose.disconnect();
  });

  const channels = await listChannelsForTenant(tenantId);
  const ebay = channels.find((c) => c.key === "ebay");
  assert.equal(ebay.last_synced_at, null);
});

test("listChannelsForTenant: needs_attention_count sums only error + price_locked, never synced/pending/not_listed/out_of_stock", async (t) => {
  await mongoose.connect(config.mongoUri);
  const tenantId = new mongoose.Types.ObjectId();
  t.after(async () => {
    await MarketplaceListing.deleteMany({ tenant_id: tenantId });
    await mongoose.disconnect();
  });

  await MarketplaceListing.create([
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.SYNCED }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.SYNCED }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.PENDING }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.OUT_OF_STOCK }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.ERROR }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.ERROR }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.PRICE_LOCKED }),
  ]);

  const channels = await listChannelsForTenant(tenantId);
  const ebay = channels.find((c) => c.key === "ebay");

  assert.equal(ebay.needs_attention_count, 3, "2 error + 1 price_locked, ignoring the other 4 listings");
  assert.equal(ebay.health_status, "needs_attention");
});

test("listChannelsForTenant: health_status is healthy when there are zero bad listings and no connection trouble", async (t) => {
  await mongoose.connect(config.mongoUri);
  const tenantId = new mongoose.Types.ObjectId();
  t.after(async () => {
    await MarketplaceListing.deleteMany({ tenant_id: tenantId });
    await mongoose.disconnect();
  });

  await MarketplaceListing.create([
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.SYNCED }),
    makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.NOT_LISTED }),
  ]);

  const channels = await listChannelsForTenant(tenantId);
  const ebay = channels.find((c) => c.key === "ebay");

  assert.equal(ebay.needs_attention_count, 0);
  assert.equal(ebay.health_status, "healthy");
});

test("listChannelsForTenant: health_status is needs_attention from a tripped circuit breaker alone, even with zero bad listings", async (t) => {
  await mongoose.connect(config.mongoUri);
  const tenantId = new mongoose.Types.ObjectId();
  t.after(async () => {
    await MarketplaceListing.deleteMany({ tenant_id: tenantId });
    await ChannelConnection.deleteMany({ tenant_id: tenantId });
    await mongoose.disconnect();
  });

  await MarketplaceListing.create([makeListing(tenantId, { sync_status: LISTING_SYNC_STATUS.SYNCED })]);
  await ChannelConnection.create({
    tenant_id: tenantId,
    platform: "ebay",
    status: CHANNEL_CONNECTION_STATUS.DEGRADED,
    consecutive_failures: 12,
    // ebay discriminator's own required-ish connection fields, if any, are
    // deliberately left at schema defaults here — this test only cares
    // about status/consecutive_failures feeding into health_status.
    connected_at: new Date(),
  });

  const channels = await listChannelsForTenant(tenantId);
  const ebay = channels.find((c) => c.key === "ebay");

  assert.equal(ebay.needs_attention_count, 0, "sanity check — no listing-level trouble here, purely connection-level");
  assert.equal(ebay.health_status, "needs_attention");
});

test("listChannelsForTenant: health_status is needs_attention from consecutive_failures > 0 even while connection.status is still 'connected'", async (t) => {
  await mongoose.connect(config.mongoUri);
  const tenantId = new mongoose.Types.ObjectId();
  t.after(async () => {
    await ChannelConnection.deleteMany({ tenant_id: tenantId });
    await mongoose.disconnect();
  });

  await ChannelConnection.create({
    tenant_id: tenantId,
    platform: "ebay",
    status: CHANNEL_CONNECTION_STATUS.CONNECTED,
    consecutive_failures: 1,
    connected_at: new Date(),
  });

  const channels = await listChannelsForTenant(tenantId);
  const ebay = channels.find((c) => c.key === "ebay");
  assert.equal(ebay.health_status, "needs_attention");
});
