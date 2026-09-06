// routes/index.js

const router = require("express").Router();
const { success } = require("../utils/http/response");

router.get("/health", (req, res) => {
  success(res, { uptime: process.uptime() }, "OK");
});

router.use("/auth", require("./auth.routes"));
router.use("/user", require("./user.routes"));
router.use("/attachment", require("./attachment.routes"));
router.use("/category", require("./category.routes"));
router.use("/customer", require("./customer.routes"));
router.use("/location", require("./location.routes"));
router.use("/product", require("./product.routes"));
router.use("/inventory", require("./inventory.routes"));
router.use("/order", require("./order.routes"));
router.use("/refund", require("./refund.routes"));
router.use("/payment", require("./payment.routes"));
router.use("/ebay", require("./ebay.routes"));
router.use("/google", require("./google.routes"));
router.use("/listings", require("./listing.routes"));
router.use("/channels", require("./channel.routes"));
router.use("/inquiry", require("./inquiry.routes"));
router.use("/newsletter", require("./newsletter.routes"));
router.use("/vehicle-model", require("./vehicle-model.routes"));
router.use("/dashboard", require("./dashboard.routes"));
router.use("/tenant-settings", require("./tenantSettings.routes"));
router.use("/domains", require("./domain.routes"));

module.exports = router;
