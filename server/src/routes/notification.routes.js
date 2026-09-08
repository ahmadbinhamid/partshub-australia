// routes/notification.routes.js

const router = require("express").Router();
const asyncHandler = require("../middlewares/asyncHandler");
const { auth, admin } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const pagination = require("../middlewares/pagination");
const v = require("../validators/notification.validation");
const ctrl = require("../controllers/notification.controller");

// admin-gated for consistency with the underlying resource (orders) — only
// admin/superadmin users ever have notification rows created for them, see
// services/notification.service.js#notifyNewOrder.
router.get("/", auth(), admin, pagination(), asyncHandler(ctrl.listNotifications));
router.patch("/read-all", auth(), admin, asyncHandler(ctrl.markAllAsRead));
router.patch("/:id/read", auth(), admin, validate(v.byIdParam), asyncHandler(ctrl.markAsRead));

module.exports = router;
