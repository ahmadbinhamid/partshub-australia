// services/order.service.notifyBestEffort.test.js
//
// notifyNewOrder is called best-effort (try/catch) from
// createManualOrder/createOrderFromEbayOrder — a broken notification
// pipeline must never fail order creation itself. Proves that guarantee by
// forcing notifyNewOrder to throw and confirming the order still comes back
// successfully created.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/order.service.notifyBestEffort.test.js

const test = require("node:test");
const { before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../config");

const Tenant = require("../models/Tenant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Location = require("../models/Location");
const Inventory = require("../models/Inventory");
const Order = require("../models/Order");

const notificationService = require("./notification.service");
const orderService = require("./order.service");

before(() => mongoose.connect(config.mongoUri));
after(() => mongoose.disconnect());

test("createManualOrder: a notifyNewOrder failure does not prevent the order from being created", async (t) => {
  const suffix = crypto.randomUUID();

  const tenant = await Tenant.create({
    name: `Notify best-effort test ${suffix}`,
    slug: `notify-best-effort-${suffix}`,
    code: `NBE${suffix.slice(0, 6).toUpperCase()}`,
  });
  const location = await Location.create({ tenant_id: tenant._id, name: `Loc ${suffix}` });
  const product = await Product.create({
    tenant_id: tenant._id,
    title: `Notify test product ${suffix}`,
    slug: `notify-test-${suffix}`,
    sku: `NTP-${suffix}`,
    price: 20,
    status: "active",
    stock_control: true,
  });
  await Inventory.create({ product: product._id, variant: null, location: location._id, stock_count: 10 });
  const customer = await Customer.create({ tenant_id: tenant._id, name: "Best Effort Customer" });

  t.after(async () => {
    await Order.deleteMany({ tenant_id: tenant._id });
    await Inventory.deleteMany({ product: product._id });
    await Product.deleteOne({ _id: product._id });
    await Location.deleteOne({ _id: location._id });
    await Customer.deleteOne({ _id: customer._id });
    await Tenant.deleteOne({ _id: tenant._id });
  });

  const notifySpy = mock.method(notificationService, "notifyNewOrder", async () => {
    throw new Error("simulated notification pipeline failure");
  });
  t.after(() => notifySpy.mock.restore());

  const order = await orderService.createManualOrder(
    {
      customer_id: customer._id,
      items: [{ product: product._id, quantity: 1 }],
      delivery_method: "pickup",
    },
    tenant,
  );

  assert.ok(order._id, "the order must still be created and returned despite notifyNewOrder throwing");
  assert.equal(order.channel, "manual");

  const persisted = await Order.findById(order._id);
  assert.ok(persisted, "the order must actually be persisted, not just returned in memory");

  assert.equal(notifySpy.mock.calls.length, 1, "notifyNewOrder must still have been attempted");
});
