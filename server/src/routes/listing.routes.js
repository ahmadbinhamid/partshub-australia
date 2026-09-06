// routes/listing.routes.js
//
// Platform-agnostic listing browse/read/delete/push — see
// services/marketplace/listing.query.service.js's module header. CREATE
// stays on each platform's own routes (POST /ebay/listings,
// POST /google/listings) since the fields a tenant fills in genuinely
// differ per platform; eBay's own PUT (the full form) also stays on
// /ebay/listings for the same reason.

const router = require("express").Router();
const asyncHandler = require("../middlewares/asyncHandler");
const { auth } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const pagination = require("../middlewares/pagination");
const v = require("../validators/listing.validation");
const ctrl = require("../controllers/listing.controller");

router.get("/", auth(), pagination(), validate(v.listListings), asyncHandler(ctrl.getListings));
router.get("/:id", auth(), asyncHandler(ctrl.getListing));
router.delete("/:id", auth(), asyncHandler(ctrl.deleteListing));
router.post("/:id/push", auth(), asyncHandler(ctrl.pushListing));

module.exports = router;
