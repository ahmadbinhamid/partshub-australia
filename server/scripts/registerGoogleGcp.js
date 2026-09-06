// scripts/registerGoogleGcp.js
//
// TASK 3 — one-off OPERATOR script. Google requires a one-time
// `developerRegistration.registerGcp` call binding this app's shared Google
// Cloud project (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) to a Merchant Center
// account before ANY of that project's Merchant API calls are trusted by
// that account — until this runs once, every productInputs call for that
// account fails 401 GCP_NOT_REGISTERED (see
// services/google/google.datasource.service.js#createDataSource, which now
// auto-recovers from that on a tenant's first connect attempt, but still
// needs the operator to wait out Google's ~5-minute propagation and retry).
// This script performs the SAME registration directly, so an operator can
// register a Merchant Center account ahead of time (or re-verify one) —
// see https://developers.google.com/merchant/api/guides/quickstart/registration.
//
// Deliberately NOT wired into the tenant connect flow (google.controller.js)
// — that flow already self-heals on first use. This is a standalone tool
// for an operator who wants to run the registration explicitly (e.g. before
// a tenant even attempts to connect, or to check what a project is
// currently registered to).
//
// IMPORTANT CONSTRAINT this script cannot get around (see
// server/docs/channel-architecture.md §9): a single GCP project can be
// registered with only ONE Merchant Center account at a time. Registering a
// second, different account fails ALREADY_REGISTERED — as currently built,
// this app's ONE shared GOOGLE_CLIENT_ID means only one tenant's Merchant
// Center account can be registered (and therefore connected) at a time.
//
// Needs an OAuth access token with the Merchant scope, authorized by a
// Google account that has access to the target Merchant Center account —
// there is no pre-existing ChannelConnection to reuse a token from before a
// tenant has ever successfully connected (the whole reason this script
// exists), so this performs its own interactive, out-of-band consent
// exchange: it prints a consent URL, the operator opens it, approves, and
// pastes back the `code` query-param value from wherever they land
// (GOOGLE_REDIRECT_URI points at this app's real /api/v1/google/oauth/callback
// route — the operator will likely land on that route's own success/error
// page; the `code` is still right there in the browser's address bar
// regardless of what that page renders). Reuses
// google.oauth.service.js#exchangeCodeForTokens for the actual token
// exchange rather than reimplementing it — only the consent URL is built
// locally here, since buildConsentUrl's own signed state additionally
// requires feedLabel/contentLanguage/targetCountry (irrelevant to a
// registration-only session) and this script never needs to verify that
// state back (no browser redirect is involved — it's a same-terminal,
// operator-run exchange, not the CSRF-relevant cross-request flow
// buildConsentUrl's state exists to protect).
//
// Usage:
//   node scripts/registerGoogleGcp.js --account=<merchant center id> --email=<developer email> [--dry-run]

require("dotenv").config();

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const config = require("../src/config");
const googleOauthService = require("../src/services/google/google.oauth.service");
const googleDatasourceService = require("../src/services/google/google.datasource.service");

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const MERCHANT_SCOPE = "https://www.googleapis.com/auth/content";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--account=")) {
      args.account = arg.slice("--account=".length);
    } else if (arg.startsWith("--email=")) {
      args.email = arg.slice("--email=".length);
    }
  }
  return args;
}

function printUsageAndExit() {
  console.error(
    "Usage: node scripts/registerGoogleGcp.js --account=<merchant center id> --email=<developer email> [--dry-run]",
  );
  process.exit(1);
}

function buildAdHocConsentUrl() {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: "code",
    scope: MERCHANT_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function promptForCode() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("\nOpen this URL, sign in with a Google account that has access to the target Merchant Center account, and approve access:\n");
    console.log(`  ${buildAdHocConsentUrl()}\n`);
    console.log(
      `You'll land on ${config.google.redirectUri} (this app's normal OAuth callback — it may show an error page ` +
        "since this script's request has no matching tenant `state`; that's expected and harmless here).",
    );
    const answer = await rl.question("Paste the FULL redirected URL, or just the `code=` value from it: ");
    const trimmed = answer.trim();
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code");
      if (code) return code;
    } catch {
      // not a URL — treat the whole answer as the raw code below
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

// Best-effort mapping of Google's documented registerGcp restrictions
// (https://developers.google.com/merchant/api/guides/quickstart/registration)
// onto whatever this specific failure's error body says. NOTE: matched by
// keyword against the raw error text, not a confirmed exact error code for
// each case (this app has only ever seen GCP_NOT_REGISTERED and
// ALREADY_REGISTERED live — see google.datasource.service.js's own
// comments) — Google's raw message is always printed alongside this, never
// replaced by it, so an unmatched restriction is still fully visible.
function explainKnownRestriction(err) {
  const body = `${err.body || ""} ${err.message || ""}`.toLowerCase();
  if (body.includes("test account") || body.includes("test_account")) {
    return "Google Merchant Center TEST accounts are not eligible for GCP registration — use a real (non-test) account.";
  }
  if (body.includes("verified") && (body.includes("website") || body.includes("website_claimed"))) {
    return "The target Merchant Center account needs a claimed AND verified website before it can be registered — see Merchant Center > Business information > Website.";
  }
  if (body.includes("subaccount") || body.includes("sub-account") || body.includes("advanced account") || body.includes("mca")) {
    return (
      "Registering a subaccount is unsupported while authenticated as its parent/Multi-Client (advanced) account — " +
      "authenticate directly as the subaccount's own Merchant Center account instead."
    );
  }
  if (err.status === 409 || body.includes("already_registered")) {
    return (
      "This GCP project is already registered to a DIFFERENT Merchant Center account — a GCP project can only be " +
      "registered to ONE account at a time (see this script's own module header and channel-architecture.md §9)."
    );
  }
  return null;
}

async function main() {
  const { account, email, dryRun } = parseArgs(process.argv.slice(2));
  if (!account || !email) printUsageAndExit();

  if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
    console.error("Google OAuth is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI first.");
    process.exit(1);
  }

  console.log(`Target Merchant Center account: ${account}`);
  console.log(`Developer email: ${email}`);
  if (dryRun) console.log("--dry-run: will NOT actually register — will still exchange a token and report current registration status.");

  const code = await promptForCode();
  let accessToken;
  try {
    ({ accessToken } = await googleOauthService.exchangeCodeForTokens(code));
  } catch (err) {
    console.error(`\nFailed to exchange the authorization code for a token: ${err.message}`);
    process.exit(1);
  }
  console.log("\nToken exchange succeeded.");

  if (!dryRun) {
    console.log(`\nRegistering this GCP project as a developer for merchant ${account}...`);
    try {
      const result = await googleDatasourceService.registerGcp(accessToken, account, email);
      console.log("Registered:", JSON.stringify(result));
    } catch (err) {
      console.error(`\nregisterGcp failed: ${err.message}`);
      const explanation = explainKnownRestriction(err);
      if (explanation) console.error(`\n  -> ${explanation}`);
      process.exitCode = 1;
      // Still attempt the verification call below — useful even after a
      // failed register (e.g. to see it's already correctly registered).
    }
  } else {
    console.log(`\n[dry-run] Would call registerGcp for account ${account} with developerEmail "${email}" — skipping.`);
  }

  console.log("\nVerifying current registration (accounts.developerRegistration.getAccountForGcpRegistration)...");
  try {
    const registration = await googleDatasourceService.getAccountForGcpRegistration(accessToken);
    const accountId = registration?.name?.split("/")[1] ?? null;
    console.log(`This GCP project is registered to: ${registration?.name ?? "(none)"}${accountId ? ` (account id: ${accountId})` : ""}`);
    console.log(`gcpIds on record: ${JSON.stringify(registration?.gcpIds ?? [])}`);
  } catch (err) {
    // A brand-new, never-registered project is a real, expected outcome
    // here (dry-run against an unregistered account, or right after a
    // failed register) — surface it plainly rather than as a bare stack
    // trace, but don't mask other failures behind a false "not registered"
    // reading.
    console.error(`\nCould not verify current registration: ${err.message}`);
    const explanation = explainKnownRestriction(err);
    if (explanation) console.error(`  -> ${explanation}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("registerGoogleGcp failed:", err);
  process.exit(1);
});
