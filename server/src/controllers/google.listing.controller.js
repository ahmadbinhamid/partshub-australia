// controllers/google.listing.controller.js
//
// Thin HTTP layer only — DB work lives in services/google/google.listing.service.js
// (create/update) and services/marketplace/listing.query.service.js (browse/
// read/delete/push, shared with eBay — see that file's own module header).
// Mirrors ebay.listing.controller.js's shape.

const listingService = require("../services/google/google.listing.service");
const { enqueueChannelJob } = require("../queues/channel.queue");
const { logger } = require("../loaders/logging");
const { success, created, notFound, badRequest, systemfailure } = require("../utils/http/response");

// Creates the listing AND immediately queues it for sync in one action —
// the "lightweight toggle" this listing flow is: unlike eBay's multi-step
// form-then-push, there's no separate "List on Google Shopping" button
// followed by a "Push" step. seq: null — no stock-change fencing token
// behind this, same convention every other manual/explicit sync call uses.
exports.createListing = async (req, res) => {
  try {
    const { product } = req.body;
    if (!product) return badRequest(res, "product is required");

    const listing = await listingService.createListing(req.body, req.tenantId);
    try {
      await enqueueChannelJob("google", "sync_listing", { listingId: listing._id.toString(), seq: null });
    } catch (err) {
      // Never turn a successfully created listing into an error response
      // over a queue hiccup — it exists and can be pushed again manually
      // (the generic /listings/:id/push route) even if this particular
      // enqueue failed.
      logger.warn("[google.listing.controller] failed to enqueue initial sync_listing after create", {
        listingId: listing._id.toString(),
        error: err.message,
      });
    }
    return created(res, listing, "Listing created and queued for Google Shopping sync");
  } catch (err) {
    if (err.code === 11000) {
      return badRequest(res, "A listing for this product/variant/platform already exists");
    }
    return systemfailure(res, err);
  }
};

exports.updateListing = async (req, res) => {
  try {
    const listing = await listingService.updateListing(req.params.id, req.body, req.tenantId);
    if (!listing) return notFound(res, "Listing not found");
    return success(res, listing, "Listing updated");
  } catch (err) {
    return systemfailure(res, err);
  }
};
