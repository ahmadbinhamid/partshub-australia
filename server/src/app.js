// app.js

const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yaml");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const routes = require("./routes");
const domainService = require("./services/domain.service");

// Register marketplace adapters — needed by the API process for endListing on delete
require("./services/marketplace/registerAdapters").registerAdapters();
const { requestLogger, errorLogger } = require("./middlewares/logging");
const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");
const requestId = require("./middlewares/requestId");

const app = express();

// Trust the X-Forwarded-Proto header set by nginx so req.protocol resolves to "https"
app.set("trust proxy", true);

// Core middlewares
app.use(requestId);
app.use(helmet());
const allowedOrigins = config.cors.allowedOrigins;
// Every tenant gets its own payment host (<slug>.PAYMENT_LINK_DOMAIN, e.g.
// parts-hub-australia.autopartspro.au — see buildPaymentBaseUrl), so a fixed
// allowedOrigins list can never enumerate them all. Accept any subdomain of
// the configured payment domain in addition to the explicit list.
const paymentDomain = config.payment.linkDomain;

async function checkOrigin(origin, cb) {
  // Allow requests with no origin (curl, mobile apps, server-to-server)
  if (!origin) return cb(null, true);
  if (allowedOrigins.includes(origin)) return cb(null, true);
  if (paymentDomain) {
    try {
      const { hostname, protocol } = new URL(origin);
      if (protocol === "https:" && (hostname === paymentDomain || hostname.endsWith(`.${paymentDomain}`))) {
        return cb(null, true);
      }
    } catch {
      // malformed Origin header — fall through to rejection
    }
  }
  // A tenant's own DNS-verified custom domain (Settings > Domains) — see
  // domain.service.js#getActiveHostnames. Only ever accepts hostnames that
  // passed TXT-record verification, never a pending/unverified one.
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === "https:") {
      const activeHostnames = await domainService.getActiveHostnames();
      if (activeHostnames.includes(hostname)) return cb(null, true);
    }
  } catch {
    // malformed Origin header, or the DB lookup failed — fall through to
    // rejection rather than fail the request open.
  }
  cb(new Error(`CORS: origin ${origin} not allowed`));
}

app.use(
  cors({
    origin:
      allowedOrigins.length > 0
        ? // NOTE (lint fix): was `async (origin, cb) => {...}` passed
          // directly as `origin` — the `cors` package never awaits or
          // attaches a handler to what this function returns, it only acts
          // on `cb(...)` being called as a side effect. Every current path
          // here does call cb(), but marking it async meant any future
          // change that threw outside a try/catch would become an
          // unhandled promise rejection (crashes the process on Node's
          // default unhandledRejection behavior) instead of a normal CORS
          // rejection. Wrapping the call site here — not async itself,
          // its own uncaught throw routed to cb(err) — closes that off.
          (origin, cb) => {
            checkOrigin(origin, cb).catch((err) => cb(err));
          }
        : true, // dev fallback: allow all
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Tenant-Slug"],
    credentials: true,
  })
);
app.use(express.json({
  limit: "1mb",
  verify: (_req, _res, buf) => { _req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(compression());

// Serve uploaded files
// Override helmet's same-origin CORP so the FE (different port) can load images
app.use("/uploads", (_req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}, express.static(config.uploads.dir));

// Auto logging (request/response)
app.use(requestLogger);

// Routes
app.use("/api/v1", routes);

const spec = YAML.parse(
  fs.readFileSync(path.join(__dirname, "../docs/openapi.yaml"), "utf8")
);

app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
// optional: raw JSON
app.get("/docs.json", (_req, res) => res.json(spec));

// 404 & error handling
app.use(notFound);
app.use(errorLogger); // logs stack traces with winston
app.use(errorHandler);

module.exports = app;
