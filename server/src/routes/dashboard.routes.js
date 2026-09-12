// routes/dashboard.routes.js

const router = require("express").Router();
const asyncHandler = require("../middlewares/asyncHandler");
const { auth, admin } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const v = require("../validators/dashboard.validation");
const ctrl = require("../controllers/dashboard.controller");

router.get("/stats", auth(), admin, asyncHandler(ctrl.getStats));
router.get("/channels", auth(), admin, asyncHandler(ctrl.getChannels));
router.get("/order-volume", auth(), admin, validate(v.getOrderVolume), asyncHandler(ctrl.getOrderVolume));
router.get("/revenue-trend", auth(), admin, validate(v.getRevenueTrend), asyncHandler(ctrl.getRevenueTrend));
router.get("/activity", auth(), admin, validate(v.getActivity), asyncHandler(ctrl.getActivity));
router.get("/critical-stock", auth(), admin, validate(v.getCriticalStock), asyncHandler(ctrl.getCriticalStock));
router.get("/activity-log", auth(), admin, validate(v.listActivityLog), asyncHandler(ctrl.listActivityLog));
router.get(
  "/activity-log/analytics",
  auth(),
  admin,
  validate(v.getActivityAnalytics),
  asyncHandler(ctrl.getActivityAnalytics),
);

module.exports = router;
