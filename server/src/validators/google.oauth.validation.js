// validators/google.oauth.validation.js
//
// TASK 4: validates POST /google/oauth/complete's body. feedLabel/
// contentLanguage are deliberately optional here — google.controller.js#
// completeConnect defaults them server-side (targetCountry / "en") per the
// review's "not required free text" instruction; only merchantId and
// targetCountry are actually required to finish connecting.

const Joi = require("joi");

const completeConnect = {
  body: Joi.object({
    merchantId: Joi.string().trim().min(1).required(),
    targetCountry: Joi.string().trim().min(1).required(),
    feedLabel: Joi.string().trim().allow(null, ""),
    contentLanguage: Joi.string().trim().allow(null, ""),
  }),
};

module.exports = { completeConnect };
