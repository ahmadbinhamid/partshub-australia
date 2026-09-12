// validators/dashboard.validation.js

const Joi = require("joi");

const getOrderVolume = {
  query: Joi.object({
    days: Joi.number().integer().min(1).max(90).default(7),
  }),
};

const getRevenueTrend = {
  query: Joi.object({
    months: Joi.number().integer().min(1).max(24).default(6),
  }),
};

const getActivity = {
  query: Joi.object({
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
};

const getCriticalStock = {
  query: Joi.object({
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
};

const listActivityLog = {
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    type: Joi.string().valid("", "order", "stock").default(""),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
    search: Joi.string().trim().max(200).allow(""),
  }),
};

const getActivityAnalytics = {
  query: Joi.object({
    from: Joi.date().iso(),
    to: Joi.date().iso(),
  }),
};

module.exports = {
  getOrderVolume,
  getRevenueTrend,
  getActivity,
  getCriticalStock,
  listActivityLog,
  getActivityAnalytics,
};
