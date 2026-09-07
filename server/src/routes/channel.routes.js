// routes/channel.routes.js
//
// Additive-only channel API — sits alongside routes/ebay.routes.js (left
// untouched by this migration) behind the same auth/tenant middleware.

const router = require("express").Router();
const asyncHandler = require("../middlewares/asyncHandler");
const { auth } = require("../middlewares/auth");
const pagination = require("../middlewares/pagination");
const ctrl = require("../controllers/channel.controller");

router.get("/", auth(), asyncHandler(ctrl.listChannels));
router.get("/:platform/logs", auth(), pagination(), asyncHandler(ctrl.getLogs));
router.post("/:platform/retry/:logId", auth(), asyncHandler(ctrl.retryLog));

module.exports = router;
