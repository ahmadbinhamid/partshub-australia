// services/google/google.environment-invariants.test.js
//
// Adapted from services/ebay/ebay.environment-invariants.test.js's static-
// source-scan technique — NOT a verbatim copy, because the underlying risk
// it guards against doesn't literally apply to Google the same way: eBay
// has a real sandbox/production URL split (settings.sandbox), and the
// original incident was a tenant-scoped SANDBOX token sent to a hardcoded
// PRODUCTION host. Google's Merchant API has no such split (see
// google.merchant.api.service.js's own module comment) — there is no
// second, "wrong environment" its base URL could point at, so the literal
// eBay rule ("no *BaseFor(false) inside a function taking settings")
// doesn't map onto real Google code.
//
// What DOES carry over, in spirit: a tenant-scoped credential must never be
// cached in a module-level variable — the same CLASS of bug (one tenant's
// data leaking into every other tenant's calls) in a different shape.
// ebay.api.service.js's own _tokenCache/_cachedCatalogToken exist
// specifically because a bare module-level token slot would do exactly
// that. This statically verifies no such bare slot exists here — every
// token is either a function parameter or lives in a Map keyed by tenant id
// (see google.oauth.service.js's own _refreshInFlight).
//
// Run with: node --test src/services/google/google.environment-invariants.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FILES = [
  path.join(__dirname, "google.merchant.api.service.js"),
  path.join(__dirname, "google.datasource.service.js"),
  path.join(__dirname, "google.oauth.service.js"),
];

// A mutable (`let`) module-level variable whose name looks like a token
// slot — deliberately NOT matching `const` here: this codebase's own URL
// constants (TOKEN_ENDPOINT, AUTH_BASE, MERCHANT_API_BASE...) legitimately
// have "token"-adjacent names but are fixed config values, not a cache a
// credential could get written into. A `let` is the actual shape a mutable
// single-tenant cache slot would take (see ebay.api.service.js's own
// `let _cachedCatalogToken = null;` for exactly this pattern, deliberately
// safe there ONLY because that one specific token is genuinely app-level,
// not per-tenant — see that function's own comment).
const MODULE_LEVEL_MUTABLE_TOKEN_RE = /^\s*let\s+(_?\w*[Tt]oken\w*)\s*=/gm;

for (const file of FILES) {
  const basename = path.basename(file);

  test(`${basename}: no tenant-scoped access token is cached in a bare module-level variable`, () => {
    const source = fs.readFileSync(file, "utf8");

    const offenders = [];
    let match;
    const re = new RegExp(MODULE_LEVEL_MUTABLE_TOKEN_RE.source, "gm");
    while ((match = re.exec(source))) {
      offenders.push(match[1]);
    }

    assert.deepEqual(
      offenders,
      [],
      "\n\nRULE: a tenant-scoped access token must always be threaded through as a function parameter " +
        "(see getValidAccessToken/insertProductInput/etc.'s own `token` parameter) or kept in a structure " +
        "explicitly keyed by tenant id (a Map, e.g. google.oauth.service.js's own _refreshInFlight) — never " +
        "a bare mutable module-level variable. A bare slot leaks one tenant's credential into every other " +
        "tenant's API calls the moment two tenants' jobs interleave.\n\n" +
        `Offending declaration(s) in ${basename}: ${offenders.join(", ")}`,
    );
  });
}

test("google.oauth.service.js: the in-flight refresh de-dup cache is a Map keyed by tenant id, not a bare shared promise", () => {
  const source = fs.readFileSync(path.join(__dirname, "google.oauth.service.js"), "utf8");
  assert.match(
    source,
    /_refreshInFlight\s*=\s*new Map\(\)/,
    "the in-flight refresh cache must be a Map keyed by tenant id — a bare shared promise would have the " +
      "exact same cross-tenant-leak shape as a bare cached token",
  );
});
