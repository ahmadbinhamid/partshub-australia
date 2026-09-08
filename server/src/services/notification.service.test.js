// services/notification.service.test.js
//
// notifyNewOrder's recipient resolution (active admin/superadmin only —
// never a plain "user"-role account, since routes/order.routes.js gates
// every order-reading route behind admin/superadmin, so a "user"-role
// account couldn't open the order a notification would link to anyway),
// the websocket push, and the list/mark-read API surface.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/notification.service.test.js

const test = require("node:test");
const { before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../config");

const Notification = require("../models/Notification");
const User = require("../models/User");
const websocketService = require("./websocket.service");
const notificationService = require("./notification.service");

// Single connection for the whole file — t.after() hooks run in
// REGISTRATION order, not LIFO, so per-test connect/disconnect is a
// footgun (see inventory-digest.service.test.js's own note on this, fixed
// this same session).
before(() => mongoose.connect(config.mongoUri));
after(() => mongoose.disconnect());

async function makeUser(tenantId, { role = "user", status = "active" } = {}) {
  const suffix = crypto.randomUUID();
  return User.create({
    tenant_id: tenantId,
    first_name: "Test",
    last_name: "User",
    email: `notif-test-${suffix}@example.com`,
    password: "password123",
    role,
    status,
  });
}

function makeFakeOrder(tenantId, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    tenant_id: tenantId,
    order_number: `TEST-${crypto.randomUUID()}`,
    channel: "manual",
    total: 5000,
    customer: { name: "Jane Doe" },
    ...overrides,
  };
}

function cleanupUsers(t, users) {
  t.after(() => User.deleteMany({ _id: { $in: users.map((u) => u._id) } }));
}

function cleanupNotifications(t, tenantId) {
  t.after(() => Notification.deleteMany({ tenant_id: tenantId }));
}

test("notifyNewOrder: creates one Notification per active admin/superadmin, skips plain users and inactive admins", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const admin = await makeUser(tenantId, { role: "admin", status: "active" });
  const superadmin = await makeUser(tenantId, { role: "superadmin", status: "active" });
  const plainUser = await makeUser(tenantId, { role: "user", status: "active" });
  const inactiveAdmin = await makeUser(tenantId, { role: "admin", status: "inactive" });
  cleanupUsers(t, [admin, superadmin, plainUser, inactiveAdmin]);
  cleanupNotifications(t, tenantId);

  const emitSpy = mock.method(websocketService, "emitToUsers", () => {});
  t.after(() => emitSpy.mock.restore());

  const order = makeFakeOrder(tenantId);
  await notificationService.notifyNewOrder(tenantId, order);

  const notifications = await Notification.find({ tenant_id: tenantId });
  const recipientIds = notifications.map((n) => n.user_id.toString());

  assert.equal(notifications.length, 2, "only the admin and superadmin should get a notification");
  assert.ok(recipientIds.includes(admin._id.toString()));
  assert.ok(recipientIds.includes(superadmin._id.toString()));
  assert.ok(!recipientIds.includes(plainUser._id.toString()), "a plain user-role account must not be notified");
  assert.ok(!recipientIds.includes(inactiveAdmin._id.toString()), "an inactive admin must not be notified");

  const one = notifications[0];
  assert.equal(one.type, "order.new");
  assert.equal(one.data.order_number, order.order_number);
  assert.equal(one.data.customer_name, "Jane Doe");
  assert.equal(one.read_at, null);
});

test("notifyNewOrder: pushes a websocket event to exactly the notified recipients' rooms", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const admin = await makeUser(tenantId, { role: "admin", status: "active" });
  cleanupUsers(t, [admin]);
  cleanupNotifications(t, tenantId);

  const emitSpy = mock.method(websocketService, "emitToUsers", () => {});
  t.after(() => emitSpy.mock.restore());

  const order = makeFakeOrder(tenantId);
  await notificationService.notifyNewOrder(tenantId, order);

  assert.equal(emitSpy.mock.calls.length, 1);
  const [userIds, event, payload] = emitSpy.mock.calls[0].arguments;
  assert.deepEqual(userIds, [admin._id.toString()]);
  assert.equal(event, "notification:new");
  assert.equal(payload.type, "order.new");
  assert.equal(payload.data.order_number, order.order_number);
});

test("notifyNewOrder: a tenant with zero admin/superadmin users is a no-op — no Notification, no emit, no throw", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const plainUser = await makeUser(tenantId, { role: "user", status: "active" });
  cleanupUsers(t, [plainUser]);
  cleanupNotifications(t, tenantId);

  const emitSpy = mock.method(websocketService, "emitToUsers", () => {
    throw new Error("must not be called — zero eligible recipients");
  });
  t.after(() => emitSpy.mock.restore());

  const order = makeFakeOrder(tenantId);
  await assert.doesNotReject(() => notificationService.notifyNewOrder(tenantId, order));

  const count = await Notification.countDocuments({ tenant_id: tenantId });
  assert.equal(count, 0);
  assert.equal(emitSpy.mock.calls.length, 0);
});

test("listNotifications: pagination and unread_count are correct against a mix of read/unread fixtures", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const otherTenantId = new mongoose.Types.ObjectId();
  const user = await makeUser(tenantId, { role: "admin" });
  cleanupUsers(t, [user]);
  cleanupNotifications(t, tenantId);
  t.after(() => Notification.deleteMany({ tenant_id: otherTenantId }));

  const docs = await Notification.insertMany([
    { tenant_id: tenantId, user_id: user._id, type: "order.new", title: "A", message: "a", read_at: null },
    { tenant_id: tenantId, user_id: user._id, type: "order.new", title: "B", message: "b", read_at: null },
    { tenant_id: tenantId, user_id: user._id, type: "order.new", title: "C", message: "c", read_at: new Date() },
    // Another tenant's notification to the SAME user id would be impossible
    // in practice (a User belongs to one tenant), but a different user under
    // a different tenant proves tenant scoping regardless.
    { tenant_id: otherTenantId, user_id: new mongoose.Types.ObjectId(), type: "order.new", title: "D", message: "d", read_at: null },
  ]);
  t.after(() => Notification.deleteMany({ _id: { $in: docs.map((d) => d._id) } }));

  const page1 = await notificationService.listNotifications(user._id, tenantId, { page: 1, limit: 2, skip: 0 });
  assert.equal(page1.total, 3);
  assert.equal(page1.unread_count, 2, "2 of the 3 fixtures for this tenant/user are unread");
  assert.equal(page1.items.length, 2);
  assert.equal(page1.totalPages, 2);

  const page2 = await notificationService.listNotifications(user._id, tenantId, { page: 2, limit: 2, skip: 2 });
  assert.equal(page2.items.length, 1);
});

test("markAsRead: only the requesting user's own notification can be marked read", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const owner = await makeUser(tenantId, { role: "admin" });
  const otherUser = await makeUser(tenantId, { role: "admin" });
  cleanupUsers(t, [owner, otherUser]);
  cleanupNotifications(t, tenantId);

  const notif = await Notification.create({
    tenant_id: tenantId,
    user_id: owner._id,
    type: "order.new",
    title: "A",
    message: "a",
    read_at: null,
  });

  await notificationService.markAsRead(notif._id, otherUser._id);
  const stillUnread = await Notification.findById(notif._id);
  assert.equal(stillUnread.read_at, null, "another user must not be able to mark this notification read");

  await notificationService.markAsRead(notif._id, owner._id);
  const nowRead = await Notification.findById(notif._id);
  assert.ok(nowRead.read_at, "the owning user must be able to mark their own notification read");
});

test("markAllAsRead: only marks the requesting user's notifications within their own tenant", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const otherTenantId = new mongoose.Types.ObjectId();
  const user = await makeUser(tenantId, { role: "admin" });
  cleanupUsers(t, [user]);
  cleanupNotifications(t, tenantId);

  const [mine1, mine2, otherTenantSameUserIdShape] = await Notification.insertMany([
    { tenant_id: tenantId, user_id: user._id, type: "order.new", title: "A", message: "a", read_at: null },
    { tenant_id: tenantId, user_id: user._id, type: "order.new", title: "B", message: "b", read_at: null },
    { tenant_id: otherTenantId, user_id: user._id, type: "order.new", title: "C", message: "c", read_at: null },
  ]);
  t.after(() =>
    Notification.deleteMany({ _id: { $in: [mine1._id, mine2._id, otherTenantSameUserIdShape._id] } }),
  );

  await notificationService.markAllAsRead(user._id, tenantId);

  const [a, b, c] = await Promise.all([
    Notification.findById(mine1._id),
    Notification.findById(mine2._id),
    Notification.findById(otherTenantSameUserIdShape._id),
  ]);
  assert.ok(a.read_at);
  assert.ok(b.read_at);
  assert.equal(c.read_at, null, "a notification under a different tenant must not be touched");
});
