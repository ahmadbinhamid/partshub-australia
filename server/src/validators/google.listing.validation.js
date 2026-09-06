// validators/google.listing.validation.js

const Joi = require("joi");

const GOOGLE_CONDITIONS = ["new", "refurbished", "used"];

const createListing = {
  body: Joi.object({
    product: Joi.string().required(),
    variant: Joi.string().allow(null),
    google_product_category: Joi.string().allow(null, ""),
    gtin: Joi.string().allow(null, ""),
    mpn: Joi.string().allow(null, ""),
    condition: Joi.string()
      .valid(...GOOGLE_CONDITIONS)
      .allow(null),
    shipping_label: Joi.string().allow(null, ""),
  }),
};

const updateListing = {
  body: Joi.object({
    google_product_category: Joi.string().allow(null, ""),
    gtin: Joi.string().allow(null, ""),
    mpn: Joi.string().allow(null, ""),
    condition: Joi.string()
      .valid(...GOOGLE_CONDITIONS)
      .allow(null),
    shipping_label: Joi.string().allow(null, ""),
    title_override: Joi.string().allow(null, ""),
    description_override: Joi.string().allow(null, ""),
    price_override: Joi.number().allow(null),
  }),
};

module.exports = { createListing, updateListing, GOOGLE_CONDITIONS };
