// controllers/notification.controller.js

const notificationService = require("../services/notification.service");
const { success, systemfailure } = require("../utils/http/response");

exports.listNotifications = async (req, res) => {
  try {
    const { page, limit, skip } = req.pagination;
    const result = await notificationService.listNotifications(req.user._id, req.tenantId, { page, limit, skip });
    return success(res, result);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.markAsRead = async (req, res) => {
  try {
    await notificationService.markAsRead(req.params.id, req.user._id);
    return success(res, null);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    await notificationService.markAllAsRead(req.user._id, req.tenantId);
    return success(res, null);
  } catch (err) {
    return systemfailure(res, err);
  }
};
