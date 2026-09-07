// services/marketplace/listing.resolver.js
//
// Merges canonical Product (+ optional Variant) content with per-channel
// overrides stored on a MarketplaceListing. Every adapter reads its publish
// payload from the resolved object — never directly from the raw listing.

function resolveSku(listing, product, variant) {
  // eBay discriminator exposes store_sku; fall through for other platforms
  if (listing.store_sku) return listing.store_sku;
  if (variant) return variant.sku || `ph-${product._id}-${variant._id}`;
  return product.sku || `ph-${product._id}`;
}

function resolvePhotos(listing, product, variant) {
  if (listing.photo_overrides && listing.photo_overrides.length > 0) {
    return listing.photo_overrides;
  }
  // Variant photos take precedence over product photos when no override is set
  if (variant && variant.attachments && variant.attachments.length > 0) {
    return variant.attachments;
  }
  return product.attachments || [];
}

function resolvePrice(listing, product, variant) {
  if (listing.price_override != null) return listing.price_override;
  if (variant) return variant.price ?? product.price ?? 0;
  return product.price ?? 0;
}

/**
 * Returns the resolved object that adapters use to build their publish payloads.
 *
 * @param {object} listing  - A MarketplaceListing document (or plain object)
 * @param {object} product  - The populated Product document
 * @param {object|null} variant - The populated ProductVariant document, or null
 */
function resolveListing(listing, product, variant = null) {
  const brand = listing.item_specifics?.brand || product.brand || null;

  return {
    sku: resolveSku(listing, product, variant),
    title: listing.title_override || product.title,
    description: listing.description_override || product.description || product.title,
    price: resolvePrice(listing, product, variant),
    brand,
    photos: resolvePhotos(listing, product, variant),
    // Pass raw documents through so adapters can read platform-specific fields
    listing: listing.toObject ? listing.toObject() : listing,
    product,
    variant,
  };
}

// Reads adapter.manifest.requiresStorefront for `platform` off the
// registry — never assumed, always looked up, so this stays correct if a
// future adapter's manifest changes without anyone remembering to update
// this file. Returns null (not a throw) for an unregistered/unknown
// platform — resolveProductUrl below treats that the same as "no
// requirement", since a platform not even registered obviously can't be
// the one enforcing anything here.
function getPlatformManifest(platform) {
  const registry = require("./registry");
  if (!platform || !registry.has(platform)) return null;
  return registry.get(platform).manifest;
}

// Resolves a product's public, canonical storefront URL — needed by any
// feed-shaped channel that requires a `link` field (Google Shopping today;
// Meta Shop later). Additive: eBay never calls this.
//
// The storefront (pha-storefront) is a SEPARATE repo, not this one — its
// product route is `/product/:slug` (singular — see its src/App.tsx).
//
// `platform` is REQUIRED — every real caller (google.adapter.js's two call
// sites) always has one, and this function needs it to know whether the
// linkDomain fallback below is even allowed for that platform at all. Fail
// loudly on a caller that forgets it, rather than silently skipping the
// requiresStorefront check for whoever omits it.
//
// Host resolution, in order:
//   1. The tenant's DEFAULT verified Domain (models/Domain.js — is_default:
//      true, status: active). A non-default active domain does NOT count
//      here, even if one exists — only the one the tenant has actually
//      designated as their default storefront host.
//   2. `<tenant.slug, hyphens stripped>.${config.payment.linkDomain}` — the
//      SAME per-tenant host stripe.payment.service.js#buildPaymentBaseUrl
//      already builds for payment links (and app.js's CORS check already
//      accepts any subdomain of, for that exact reason), reused here rather
//      than invented fresh: the storefront is served on this same per-
//      tenant subdomain regardless of a tenant's payment_domain_mode
//      setting (that field controls payment-link hosting specifically, not
//      the storefront). Hyphens are stripped from the slug for the same
//      reason buildPaymentBaseUrl strips them — see that function's own
//      comment. NOT offered at all to a platform whose manifest declares
//      `requiresStorefront: true` (see channel.service.js#checkStorefrontRequirement,
//      which already refuses to even let such a tenant CONNECT without a
//      verified Domain) — a shared subdomain of this platform's own domain
//      is not something the tenant could claim/verify ownership of with
//      Google, so it was never a legitimate storefront for that channel;
//      letting it through here would have quietly contradicted that
//      connect-time guard for any tenant who got connected some other way
//      (e.g. before the guard existed, or via direct DB access).
// Throws — never guesses — when neither a verified default Domain NOR (for
// a platform that's allowed to use it) the linkDomain fallback resolves to
// something real. tenant.slug itself is a required, always-present field
// (models/Tenant.js), so once linkDomain is configured (and allowed) that
// fallback is always resolvable — the only other failure mode guarded here
// is the tenant record itself somehow not resolving at all (deleted
// mid-request).
//
// Product.slug is NOT a required field (models/Product.js) — a product
// with none fails loudly, naming the SKU, rather than building a URL with
// an empty/undefined path segment.
async function resolveProductUrl(tenantId, productSlug, sku, platform) {
  if (!productSlug) {
    throw new Error(`Product (SKU ${sku ?? "unknown"}) has no slug — cannot build a public product URL`);
  }
  if (!platform) {
    throw new Error("resolveProductUrl: platform is required (needed to check requiresStorefront before allowing the linkDomain fallback)");
  }

  const Domain = require("../../models/Domain");
  const Tenant = require("../../models/Tenant");
  const config = require("../../config");
  const { DOMAIN_STATUS } = require("../../constants/domain.constants");

  const domain = await Domain.findOne({ tenant_id: tenantId, is_default: true, status: DOMAIN_STATUS.ACTIVE })
    .select("hostname")
    .lean();

  const manifest = getPlatformManifest(platform);
  const platformName = manifest?.name || platform;

  let host;
  if (domain) {
    host = domain.hostname;
  } else if (manifest?.requiresStorefront) {
    throw new Error(
      `No verified default domain for tenant ${tenantId} — ${platformName} requires a real, claimed-and-verified ` +
        `storefront domain and cannot fall back to a shared ${config.payment.linkDomain || "PAYMENT_LINK_DOMAIN"} ` +
        `subdomain (that's this platform's own domain, not one the tenant can verify ownership of with ${platformName}). ` +
        `Connect and verify a domain under Settings > Domains before connecting ${platformName}.`,
    );
  } else if (config.payment.linkDomain) {
    const tenant = await Tenant.findById(tenantId).select("slug").lean();
    if (!tenant?.slug) {
      throw new Error(`Tenant ${tenantId} could not be resolved (or has no slug) — cannot build a fallback storefront URL`);
    }
    host = `${tenant.slug.replace(/-/g, "")}.${config.payment.linkDomain}`;
  } else {
    throw new Error(
      `No verified default domain and no PAYMENT_LINK_DOMAIN fallback configured for tenant ${tenantId} — ` +
        `cannot build a public product URL (required for ${platformName}'s "link" field). Set a default ` +
        `verified domain under Settings > Domains, or configure PAYMENT_LINK_DOMAIN.`,
    );
  }

  return `https://${host}/product/${productSlug}`;
}

// Resolves which product identifier(s) to send a channel that requires them
// (Google Shopping's gtin/mpn+brand/identifierExists trio; Meta Shop has an
// equivalent concept). Returns the raw available data only — deliberately
// does NOT decide the channel-specific field names/branching (e.g. Google's
// `identifierExists: false`), since that's a platform-specific mapping, not
// a generic listing-resolution concern; see google.adapter.js for that.
// Never invents or derives an identifier — a missing gtin/mpn/brand stays
// null, exactly as stored.
function resolveIdentifiers(listing, product) {
  // gtin has no product-level fallback — Product has no gtin field at all
  // (only mpn/brand do), so this is only ever whatever's set on the
  // Google-specific listing discriminator.
  const gtin = listing.gtin || null;
  // item_specifics.mpn is eBay's own discriminator field — checked here too
  // (not just listing.mpn/product.mpn) so a product that already has its
  // MPN filled in via an eBay listing doesn't need it re-entered separately
  // for Google; undefined/harmless for a listing that has no item_specifics
  // at all (every non-eBay platform).
  const mpn = listing.mpn || listing.item_specifics?.mpn || product.mpn || null;
  const brand = listing.item_specifics?.brand || product.brand || null;
  return { gtin, mpn, brand };
}

module.exports = { resolveListing, resolveSku, resolveProductUrl, resolveIdentifiers };
