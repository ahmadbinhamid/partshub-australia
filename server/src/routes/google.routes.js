// routes/google.routes.js
//
// OAuth connect flow + listing CREATE/UPDATE, mirroring routes/ebay.routes.js's
// own shape. Status/logs/retry are already generic — see
// routes/channel.routes.js, reused as-is rather than duplicated here.
// Listing browse/read/delete/push are ALSO generic — see
// routes/listing.routes.js and services/marketplace/listing.query.service.js's
// own module header for why only create/update stay platform-specific.

const router = require("express").Router();
const asyncHandler = require("../middlewares/asyncHandler");
const { auth } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const v = require("../validators/google.listing.validation");
const ctrl = require("../controllers/google.controller");
const listingCtrl = require("../controllers/google.listing.controller");

// ── OAuth consent flow ───────────────────────────────────────────────────────
router.get("/oauth/connect-url", auth(), asyncHandler(ctrl.getConnectUrl));
// Public — Google redirects the browser here directly, no JWT available.
router.get("/oauth/callback", asyncHandler(ctrl.oauthCallback));

// ── Listings (create/update only — see routes/listing.routes.js for the rest) ──
router.post("/listings", auth(), validate(v.createListing), asyncHandler(listingCtrl.createListing));
router.put("/listings/:id", auth(), validate(v.updateListing), asyncHandler(listingCtrl.updateListing));

module.exports = router;
