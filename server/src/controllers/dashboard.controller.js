// controllers/dashboard.controller.js

const dashboardService = require("../services/dashboard.service");
const { success, systemfailure } = require("../utils/http/response");

exports.getStats = async (req, res) => {
  try {
    const stats = await dashboardService.getStats(req.tenantId);
    return success(res, stats);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getChannels = async (req, res) => {
  try {
    const { channels } = await dashboardService.getChannelHealth(req.tenantId);
    return success(res, channels);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getOrderVolume = async (req, res) => {
  try {
    const points = await dashboardService.getOrderVolumeTrend(req.tenantId, req.query.days);
    return success(res, points);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getRevenueTrend = async (req, res) => {
  try {
    const points = await dashboardService.getMonthlyRevenueTrend(req.tenantId, req.query.months);
    return success(res, points);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getActivity = async (req, res) => {
  try {
    const events = await dashboardService.getRecentActivity(req.tenantId, req.query.limit);
    return success(res, events);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getCriticalStock = async (req, res) => {
  try {
    const rows = await dashboardService.getCriticalStock(req.tenantId, req.query.limit);
    return success(res, rows);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.listActivityLog = async (req, res) => {
  try {
    const { page, limit, type, from, to, search } = req.query;
    const result = await dashboardService.listActivity(req.tenantId, { page, limit, type, from, to, search });
    return success(res, result);
  } catch (err) {
    return systemfailure(res, err);
  }
};

exports.getActivityAnalytics = async (req, res) => {
  try {
    const analytics = await dashboardService.getActivityAnalytics(req.tenantId, { from: req.query.from, to: req.query.to });
    return success(res, analytics);
  } catch (err) {
    return systemfailure(res, err);
  }
};
