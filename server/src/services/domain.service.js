// services/domain.service.js

const dns = require("dns").promises;
const Domain = require("../models/Domain");
const { logger } = require("../loaders/logging");
const { DOMAIN_STATUS } = require("../constants/domain.constants");

const VERIFICATION_SUBDOMAIN = "_pha-verify";

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// The TXT record a tenant must publish to prove ownership — a subdomain
// prefix (not a TXT record directly on the apex) so it never collides with
// a TXT record the tenant already has there for something else (SPF, domain
// verification for another service, etc).
function getVerificationRecordName(hostname) {
  return `${VERIFICATION_SUBDOMAIN}.${hostname}`;
}

async function listDomains(tenantId) {
  return Domain.find({ tenant_id: tenantId }).sort({ is_default: -1, created_at: -1 });
}

async function createDomain(hostname, tenantId) {
  const normalized = hostname.trim().toLowerCase();

  const existing = await Domain.findOne({ hostname: normalized });
  if (existing) {
    // Deliberately vague about WHICH tenant owns it — confirming "someone
    // else already owns this domain" to an unauthenticated-for-that-domain
    // caller is a minor enumeration leak, same reasoning as a generic
    // "invalid credentials" message on login.
    throw httpError("This domain is already registered", 409);
  }

  return Domain.create({
    tenant_id: tenantId,
    hostname: normalized,
    verification_token: Domain.generateVerificationToken(),
  });
}

async function deleteDomain(id, tenantId) {
  const domain = await Domain.findOne({ _id: id, tenant_id: tenantId });
  if (!domain) return null;
  if (domain.is_default) {
    throw httpError("Cannot delete the default domain — set another domain as default first", 400);
  }
  await domain.softDelete();
  return domain;
}

// Unset any existing default for this tenant, then set the new one — not a
// single atomic operation (standalone MongoDB here, no replica set, no
// multi-document transactions — same constraint noted elsewhere in this
// codebase, e.g. tenant.service.js). A domain must be ACTIVE (verified)
// before it can become the default; there's no reason to route
// traffic/payments at an unproven hostname.
async function setDefaultDomain(id, tenantId) {
  const domain = await Domain.findOne({ _id: id, tenant_id: tenantId });
  if (!domain) return null;
  if (domain.status !== DOMAIN_STATUS.ACTIVE) {
    throw httpError("Only a verified domain can be set as default", 400);
  }

  await Domain.updateMany({ tenant_id: tenantId, is_default: true }, { $set: { is_default: false } });
  domain.is_default = true;
  await domain.save();
  return domain;
}

// Looks up the TXT record and compares it against this domain's own
// verification_token — never trusts a hostname just because SOME TXT record
// exists there, only the exact one this app issued.
async function verifyDomainDns(id, tenantId) {
  const domain = await Domain.findOne({ _id: id, tenant_id: tenantId });
  if (!domain) return null;

  const recordName = getVerificationRecordName(domain.hostname);
  let records = [];
  try {
    records = await dns.resolveTxt(recordName);
  } catch (err) {
    // ENOTFOUND/ENODATA — no such record yet, not a system error. Anything
    // else (DNS server unreachable, etc.) still just means "not verified
    // yet", but is logged since it may indicate an infra problem worth
    // noticing rather than a tenant who hasn't set up DNS.
    if (err.code !== "ENOTFOUND" && err.code !== "ENODATA") {
      logger.warn(`[domain.service] DNS lookup error for ${recordName}: ${err.message}`);
    }
  }

  // resolveTxt returns string[][] — each TXT record's value, possibly split
  // across multiple <255-char chunks the DNS provider concatenates back
  // together; join before comparing.
  const found = records.some((chunks) => chunks.join("") === domain.verification_token);

  if (found) {
    domain.status = DOMAIN_STATUS.ACTIVE;
    domain.verified_at = new Date();
    await domain.save();
  }

  return { domain, verified: found, recordName, expectedValue: domain.verification_token };
}

// Every currently-active hostname across every tenant — CORS (app.js) reads
// this to accept a verified custom domain as a request Origin, in addition
// to the existing CORS_ALLOWED_ORIGINS env list. Not tenant-scoped: CORS
// runs before any tenant is resolved from the request, so this can only
// answer "is this hostname a verified domain for SOME tenant", which is
// sufficient — hostname is already enforced globally unique above.
//
// Cached in-process for CACHE_TTL_MS — this runs on the CORS check for
// EVERY request, and a domain's active/inactive status changing is a rare,
// administrative event, not something that needs to be instantly
// consistent. A brief staleness window here is a fine trade for not adding
// a DB round trip to every single request. Not a correctness-sensitive
// cache: worst case, a just-verified domain takes up to CACHE_TTL_MS extra
// to start being accepted, or a just-deleted one takes that long to stop.
const CACHE_TTL_MS = 60_000;
let hostnameCache = { hostnames: [], expiresAt: 0 };

async function getActiveHostnames() {
  if (Date.now() < hostnameCache.expiresAt) return hostnameCache.hostnames;

  const domains = await Domain.find({ status: DOMAIN_STATUS.ACTIVE }).select("hostname").lean();
  hostnameCache = { hostnames: domains.map((d) => d.hostname), expiresAt: Date.now() + CACHE_TTL_MS };
  return hostnameCache.hostnames;
}

// TASK 5 (requiresStorefront capability): does this tenant have a real,
// DNS-verified storefront domain of their OWN — the specific thing a
// channel like Google Shopping needs (Merchant Center requires a claimed
// AND verified website; see google.adapter.js's manifest.requiresStorefront
// and channel.service.js#listChannelsForTenant). Deliberately the SAME
// query listing.resolver.js#resolveProductUrl's "primary" host-resolution
// branch uses (is_default: true, status: ACTIVE) — but, unlike
// resolveProductUrl, does NOT also accept the PAYMENT_LINK_DOMAIN
// tenant-subdomain fallback as sufficient here: that fallback is a
// subdomain of THIS platform's own domain, which the tenant doesn't
// control and couldn't verify ownership of with Google even if asked —
// fine as a payment-link host, not a real storefront a channel can require.
async function hasVerifiedDefaultDomain(tenantId) {
  const domain = await Domain.exists({ tenant_id: tenantId, is_default: true, status: DOMAIN_STATUS.ACTIVE });
  return !!domain;
}

module.exports = {
  listDomains,
  createDomain,
  deleteDomain,
  setDefaultDomain,
  verifyDomainDns,
  getActiveHostnames,
  getVerificationRecordName,
  hasVerifiedDefaultDomain,
};
