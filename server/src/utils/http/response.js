const _ = require("lodash");
const { logger } = require("../../loaders/logging");
const { sendErrorAlert } = require("../emailSender");

const success = (response, data, message = "OK", token) => {
  const payload = { status: "Success", message };
  if (data !== undefined) _.extend(payload, { data });
  if (token) _.extend(payload, { token });
  return response.status(200).json(payload);
};

const created = (response, data, message = "Created") => {
  const payload = { status: "Success", message };
  if (data !== undefined) _.extend(payload, { data });
  return response.status(201).json(payload);
};

const systemfailure = (response, err) => {
  let message = "Error in handling this request. Please contact system admin.";
  let status = 500;

  if (typeof err === "object" && err.status) status = err.status;
  if (typeof err === "object" && err.message) message = err.message;

  logger.error({
    message: err?.message || "System failure",
    type: "systemfailure",
    stack: err?.stack || null,
  });

  if (
    [
      "MongooseServerSelectionError",
      "MongoNetworkError",
      "MongoTimeoutError",
    ].includes(err?.name) &&
    process.env.APP_ENV === "production"
  ) {
    // NOTE (lint fix): sendErrorAlert has its own internal try/catch (see
    // utils/emailSender.js) and never actually rejects — `void` documents
    // this fire-and-forget alert is deliberate, not a missed await
    // (awaiting it would delay every failed request on an SMTP round trip
    // for an alert the caller doesn't need the result of).
    void sendErrorAlert(
      "🚨 MongoDB Connection Error",
      `${err?.name}\n\n${err?.stack || ""}`,
    );
  }

  return response
    .status(status)
    .json({ status: "Fail", systemfailure: true, message, data: null });
};

const requestfailure = (response, err, jsonerr = null) => {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 404;
  const message =
    typeof err === "object" && err.message ? err.message : String(err);

  logger.error({
    message: err?.message || "Unhandled error",
    type: "requestfailure",
    stack: err?.stack || null,
  });

  return response
    .status(status)
    .json({ status: "Fail", systemfailure: false, message, jsonerr });
};

const badRequest = (response, message = "Bad Request") =>
  response
    .status(400)
    .json({ status: "Fail", systemfailure: false, message, data: null });
const requestConflict = (response, message = "Conflict") =>
  response
    .status(409)
    .json({ status: "Fail", systemfailure: false, message, data: null });
const unauthorized = (response, message = "Unauthorized") =>
  response
    .status(401)
    .json({ status: "Fail", systemfailure: false, message, data: null });
const forbidden = (response, message = "Forbidden") =>
  response
    .status(403)
    .json({ status: "Fail", systemfailure: false, message, data: null });
const notFound = (response, message = "Not Found") =>
  response
    .status(404)
    .json({ status: "Fail", systemfailure: false, message, data: null });

const validationError = (response, errors) =>
  response
    .status(422)
    .json({ status: "Fail", systemfailure: false, message: "Validation failed", errors, data: null });

module.exports = {
  success,
  created,
  badRequest,
  systemfailure,
  requestfailure,
  requestConflict,
  unauthorized,
  forbidden,
  notFound,
  validationError,
};
