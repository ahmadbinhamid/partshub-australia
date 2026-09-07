// services/marketplace/registerAdapters.js
//
// Single place that knows the full list of marketplace adapters. Every
// process that touches MarketplaceListing sync (the API — endListing on
// delete, inventory fan-out; workers/channel.worker.js — job processing)
// calls this once at startup instead of duplicating the adapter list, so
// adding Google Shopping / Meta Shop later is a one-line change here.

const registry = require("./registry");
const ebayAdapter = require("./adapters/ebay.adapter");
const googleAdapter = require("./adapters/google.adapter");

function registerAdapters() {
  registry.register(ebayAdapter);
  registry.register(googleAdapter);
}

module.exports = { registerAdapters };
