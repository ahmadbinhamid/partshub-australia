// validators/listing.validation.js
//
// Mirrors ebay.listing.validation.js's own listListings query shape, minus
// the platform hardcoding — see listing.query.service.js's module header for
// why this generic layer exists alongside (not instead of) each platform's
// own create/update validators.

const Joi = require("joi");
const { LISTING_STATE, LISTING_SYNC_STATUS, MARKETPLACE_PLATFORM } = require("../constants/marketplace.constants");

const listListings = {
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    product: Joi.string(),
    // Comma-separated product ids — see listing.query.service.js#listListings
    // for why this bypasses pagination.
    product_in: Joi.string(),
    platform: Joi.string().valid(...Object.values(MARKETPLACE_PLATFORM)),
    state: Joi.string().valid(...Object.values(LISTING_STATE)),
    sync_status: Joi.string().valid(...Object.values(LISTING_SYNC_STATUS)),
    search: Joi.string().allow(""),
    // TASK 6: one row per PRODUCT (with all of that product's listings
    // nested under it) instead of one row per listing — see
    // listing.query.service.js#listListingsGroupedByProduct. A query flag
    // on the existing endpoint rather than a new route, so every existing
    // caller of GET /listings (omitting this) keeps the unchanged,
    // one-row-per-listing response shape.
    group_by: Joi.string().valid("product"),
  }),
};

module.exports = { listListings };
