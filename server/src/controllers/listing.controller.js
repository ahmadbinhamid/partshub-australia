// controllers/listing.controller.js
//
// Thin HTTP layer over listing.query.service.js — the platform-agnostic
// browse/read/delete/push counterpart to each platform's own listing
// controller (ebay.listing.controller.js, google.listing.controller.js),
// which stay platform-specific only for CREATE (see that service's own
// module header for why). Mirrors ebay.listing.controller.js's shape for
// the overlapping actions.

const { logger } = require("../loaders/logging");
const listingQueryService = require("../services/marketplace/listing.query.service");
const { success, notFound, systemfailure } = require("../utils/http/response");

exports.getListings = async (req, res) => {
  try {
    const { page, limit, skip } = req.pagination;
    const { product, product_in, platform, state, sync_status, search } = req.query;

    const { items, total } = await listingQueryService.listListings(
      {
        skip,
        limit,
        product,
        product_in: product_in ? product_in.split(",").filter(Boolean) : undefined,
        platform,
        state,
        sync_status,
        search,
      },
      req.tenantId,
    );

    return success(res, {
      items,
      total,
      page,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getListing = async (req, res) => {
  try {
    const listing = await listingQueryService.getListingById(req.params.id, req.tenantId);
    if (!listing) return notFound(res, "Listing not found");
    return success(res, listing);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.deleteListing = async (req, res) => {
  try {
    const listing = await listingQueryService.deleteListing(req.params.id, req.tenantId, { logger });
    if (!listing) return notFound(res, "Listing not found");
    return success(res, null, "Listing deleted");
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.pushListing = async (req, res) => {
  try {
    const listing = await listingQueryService.pushListing(req.params.id, req.tenantId);
    if (!listing) return notFound(res, "Listing not found");
    return success(res, { queued: true }, `Listing queued for ${listing.platform} sync`);
  } catch (err) {
    return systemfailure(res, err);
  }
};
