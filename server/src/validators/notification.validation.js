// validators/notification.validation.js

const Joi = require("joi");

const byIdParam = {
  params: Joi.object({ id: Joi.string().hex().length(24).required() }),
};

module.exports = { byIdParam };
