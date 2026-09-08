// services/notification.service.js
//
// Owns all Notification model access. Recipients for an order-type
// notification are every active admin/superadmin user on the tenant —
// routes/order.routes.js gates every order-reading route behind the same
// admin/superadmin check, so a plain "user"-role account couldn't open the
// order a notification would link to anyway.

const Notification = require("../models/Notification");
const User = require("../models/User");
const { USER_ROLE, USER_STATUS } = require("../constants/user.constants");
const websocketService = require("./websocket.service");

async function notifyNewOrder(tenantId, order) {
  const recipients = await User.find({
    tenant_id: tenantId,
    role: { $in: [USER_ROLE.ADMIN, USER_ROLE.SUPERADMIN] },
    status: USER_STATUS.ACTIVE,
  }).select("_id");

  if (!recipients.length) return;

  const data = {
    order_id: order._id,
    order_number: order.order_number,
    channel: order.channel,
    total: order.total,
    customer_name: order.customer?.name || null,
  };
  const title = "New order received";
  const message = `Order ${order.order_number} was just placed${data.customer_name ? ` by ${data.customer_name}` : ""}.`;

  await Notification.insertMany(
    recipients.map((r) => ({
      tenant_id: tenantId,
      user_id: r._id,
      type: "order.new",
      title,
      message,
      data,
    })),
  );

  websocketService.emitToUsers(
    recipients.map((r) => r._id.toString()),
    "notification:new",
    { type: "order.new", title, message, data },
  );
}

async function listNotifications(userId, tenantId, { page, limit, skip }) {
  const filter = { user_id: userId, tenant_id: tenantId };
  const [items, total, unread_count] = await Promise.all([
    Notification.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, read_at: null }),
  ]);
  return { items, total, unread_count, page, pageSize: limit, totalPages: Math.ceil(total / limit) };
}

async function markAsRead(notificationId, userId) {
  await Notification.updateOne(
    { _id: notificationId, user_id: userId, read_at: null },
    { read_at: new Date() },
  );
}

async function markAllAsRead(userId, tenantId) {
  await Notification.updateMany(
    { user_id: userId, tenant_id: tenantId, read_at: null },
    { read_at: new Date() },
  );
}

module.exports = { notifyNewOrder, listNotifications, markAsRead, markAllAsRead };
