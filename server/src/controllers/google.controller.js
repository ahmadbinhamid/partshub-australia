// controllers/google.controller.js
//
// Thin HTTP layer only — all DB/API work happens in services/google/*, per
// this codebase's own service-layer convention. Mirrors
// controllers/ebay.controller.js's OAuth section shape. Status/logs/retry
// are already covered generically by GET /api/v1/channels and its
// sub-routes (see channel.routes.js/channel.controller.js) — not
// duplicated here.
//
// TASK 4: the connect flow is now two authenticated steps either side of
// the OAuth redirect, instead of one shot with every field required up
// front — see google.oauth.service.js's own module comments for the full
// reasoning:
//   1. getConnectUrl (below)  — no merchant fields needed at all any more.
//   2. [Google's hosted consent screen]
//   3. oauthCallback (below)  — saves the token as PENDING, redirects to
//      the dashboard with google_connect=choose_account.
//   4. getAccounts (below)    — dashboard fetches which Merchant Center
//      accounts this token can reach, for a dropdown.
//   5. completeConnect (below) — tenant picks an account (+ confirms feed
//      settings), this finishes the connection.

const oauthService = require("../services/google/google.oauth.service");
const channelService = require("../services/marketplace/channel.service");
const { logger } = require("../loaders/logging");
const config = require("../config");
const { success, badRequest, systemfailure } = require("../utils/http/response");

// Authenticated — returns the URL the dashboard should navigate to so the
// tenant's admin can grant consent on Google's own hosted screen. No query
// params needed any more (see module header) — consent happens before any
// Merchant Center account is chosen.
//
// TASK 5: refuses to even START the OAuth dance for a tenant that can't
// actually use this channel (no verified storefront domain — Merchant
// Center requires a claimed+verified website) — generic check, driven by
// google.adapter.js's own manifest.requiresStorefront flag, see
// channel.service.js#checkStorefrontRequirement's own comment. Letting the
// tenant connect anyway would silently get every product disapproved on
// Google's side, invisible to this app.
exports.getConnectUrl = async (req, res) => {
  try {
    const storefrontCheck = await channelService.checkStorefrontRequirement(req.tenantId, "google");
    if (!storefrontCheck.ok) return badRequest(res, storefrontCheck.reason);

    const url = oauthService.buildConsentUrl({ tenantId: req.tenantId });
    return success(res, { url });
  } catch (err) {
    return systemfailure(res, err);
  }
};

// Public — Google redirects the browser here directly after consent, so
// there's no JWT to authenticate the request with. Trust is instead placed
// in the signed `state` round-tripped through Google (see
// google.oauth.service.js). Only exchanges the code and saves it as a
// PENDING connection — no Merchant-Center-specific work (ensureDataSource,
// etc.) happens here any more, so the only failure modes left at this step
// are OAuth-layer ones (bad/expired code, bad state).
exports.oauthCallback = async (req, res) => {
  const dashboardUrl = config.emailBrand.clientUrl;
  // /settings/google (not bare /settings — the settings index route just
  // Navigates to /settings/business-info, dropping any query string, so a
  // bare /settings?google_connect=... would never actually reach
  // GoogleConnectCard's success/error banner).
  const redirect = (params) => res.redirect(`${dashboardUrl}/settings/google?${new URLSearchParams(params).toString()}`);

  try {
    const { code, state, error: consentError } = req.query;
    if (consentError) return redirect({ google_connect: "error", reason: consentError });
    if (!code || !state) return redirect({ google_connect: "error", reason: "missing_code_or_state" });

    const { tenantId } = oauthService.resolveState(state);
    await oauthService.savePendingConnection({ tenantId, code });

    return redirect({ google_connect: "choose_account" });
  } catch (err) {
    // err.cause is where Node's fetch (undici) actually puts the real
    // network-level reason for a generic "fetch failed" TypeError (DNS
    // failure, connect timeout, TLS error, etc.) — found live: this was
    // logging only "fetch failed" with no way to tell it apart from a real
    // Google-side rejection, which hid an IPv6-routing timeout to
    // merchantapi.googleapis.com behind an unhelpful message.
    logger.error("[google.controller] oauthCallback error", {
      error: err.message,
      cause: err.cause ? String(err.cause) : undefined,
      code: err.code,
    });
    return redirect({ google_connect: "error", reason: "exchange_failed" });
  }
};

// Authenticated — the dashboard calls this right after landing back with
// google_connect=choose_account, to populate the account-picker dropdown.
// Never a hard failure for the frontend to handle: if Merchant API's
// accounts.list itself isn't reachable/usable for this token (permissions,
// an API-shape surprise, anything), that's reported as
// `{ accounts: [], listSupported: false, message }` with a 200 — TASK 4's
// explicit fallback — rather than an HTTP error, so the frontend can fall
// back to the manual Merchant Center ID field instead of dead-ending.
exports.getAccounts = async (req, res) => {
  try {
    const accounts = await oauthService.listAccessibleAccounts(req.tenantId);
    return success(res, { accounts, listSupported: true });
  } catch (err) {
    if (err.code === "NO_PENDING_CONNECTION") return badRequest(res, err.message);
    logger.warn("[google.controller] accounts.list unavailable — falling back to manual entry", {
      tenantId: String(req.tenantId),
      error: err.message,
    });
    return success(res, { accounts: [], listSupported: false, message: err.message });
  }
};

// Authenticated — finishes the connect flow once the tenant has picked (or
// typed) a Merchant Center account and confirmed feed settings.
// feedLabel/contentLanguage are optional here and defaulted server-side
// too (not just in the frontend form) — targetCountry and 'en'
// respectively — so this endpoint is correct even for a caller that skips
// them entirely, per the review's "not required free text" instruction.
exports.completeConnect = async (req, res) => {
  try {
    const { merchantId, targetCountry } = req.body;
    if (!merchantId) return badRequest(res, "merchantId is required");
    if (!targetCountry) return badRequest(res, "targetCountry is required");
    const feedLabel = req.body.feedLabel || targetCountry;
    const contentLanguage = req.body.contentLanguage || "en";

    // Re-derive which accounts this token can actually reach, and reject a
    // mismatched merchantId BEFORE calling ensureDataSource, whenever that
    // check is available — the manual-entry fallback (listSupported: false
    // on the frontend) skips straight to ensureDataSource's own natural
    // failure as its reachability check instead (see
    // google.oauth.service.js#completeConnection's own comment on
    // verifiedAccountIds).
    let verifiedAccountIds;
    try {
      const accounts = await oauthService.listAccessibleAccounts(req.tenantId);
      verifiedAccountIds = accounts.map((a) => String(a.accountId));
    } catch {
      verifiedAccountIds = undefined;
    }

    const conn = await oauthService.completeConnection({
      tenantId: req.tenantId,
      merchantId,
      feedLabel,
      contentLanguage,
      targetCountry,
      verifiedAccountIds,
    });

    if (!conn) {
      return badRequest(res, "No pending Google OAuth session found for this tenant — start the connect flow again.");
    }

    // Kick off the tenant's first full-catalogue sync now that the data
    // source is ready. NOTE: this run doesn't add a separate manual
    // "resync everything" admin route — Task 3's scope (an earlier run's
    // Task 3, not this run's Task 3) is the sync_batch mechanism itself,
    // and this connect-time trigger is the one call site that actually
    // needs it, per the "only build what's used" instruction. A future
    // manual-resync route (if ever added) would just call enqueueChannelJob
    // the same way.
    try {
      const { enqueueChannelJob } = require("../queues/channel.queue");
      // Longer timeout than the queue's 60s default — a full-catalogue
      // sync legitimately runs far longer than a single-listing push.
      await enqueueChannelJob("google", "sync_batch", { tenantId: String(req.tenantId) }, { timeout: 30 * 60_000 });
    } catch (err) {
      // Never turn a successful connect into an error response over a
      // queue hiccup — the data source and credentials are already saved.
      logger.warn("[google.controller] failed to enqueue initial sync_batch after connect", {
        tenantId: String(req.tenantId),
        error: err.message,
      });
    }

    logger.info("[google.controller] Tenant finished connecting via OAuth", { tenantId: String(req.tenantId) });
    return success(res, { connected: true });
  } catch (err) {
    // err.code from google.datasource.service.js#createDataSource's own
    // recovery paths, or google.oauth.service.js#completeConnection's own
    // MERCHANT_NOT_ACCESSIBLE check — surfaced as a `reason` field (not
    // just `message`) so GoogleConnectCard's connectErrorMessage(reason)
    // can show its existing friendly copy for these, the same way it did
    // when this same set of reasons arrived via oauthCallback's redirect
    // query string. badRequest() itself has no `reason` slot (shared by
    // every controller in the app — not widened just for this), so these
    // specific branches build the 400 response directly instead.
    const KNOWN_REASONS = {
      GCP_REGISTRATION_PENDING: "registration_pending",
      GCP_REGISTRATION_CONFLICT: "registration_conflict",
      MERCHANT_NOT_ACCESSIBLE: "merchant_not_accessible",
      NO_PENDING_CONNECTION: "no_pending_connection",
    };
    const reason = KNOWN_REASONS[err.code];
    if (reason) {
      return res.status(400).json({ status: "Fail", systemfailure: false, message: err.message, reason, data: null });
    }
    logger.error("[google.controller] completeConnect error", { error: err.message, code: err.code });
    return systemfailure(res, err);
  }
};
