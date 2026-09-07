// constants/marketplace.constants.js

const MARKETPLACE_PLATFORM = Object.freeze({
  EBAY: "ebay",
  GOOGLE: "google",
  AMAZON: "amazon",   // future
  SHOPIFY: "shopify", // future
});

const LISTING_STATE = Object.freeze({
  DRAFT: "draft",
  ACTIVE: "active",
  ENDED: "ended",
});

// Superset of the legacy EBAY_SYNC_STATUS values on Product so the
// inventory-list cache stays forward-compatible.
const LISTING_SYNC_STATUS = Object.freeze({
  NOT_LISTED: "not_listed",
  PENDING: "pending",
  SYNCED: "synced",
  OUT_OF_STOCK: "out_of_stock",
  // Listing is live and otherwise in sync, but eBay rejected the last price
  // update because the offer is part of an active eBay sale/promotion — see
  // EBAY_ERROR_CODE.PRICE_LOCKED_BY_ACTIVE_SALE. Distinct from ERROR: this
  // isn't a failure to fix, just a state that resolves itself once the sale
  // ends (or is reconfigured on eBay to allow price updates).
  PRICE_LOCKED: "price_locked",
  ERROR: "error",
});

module.exports = { MARKETPLACE_PLATFORM, LISTING_STATE, LISTING_SYNC_STATUS };
