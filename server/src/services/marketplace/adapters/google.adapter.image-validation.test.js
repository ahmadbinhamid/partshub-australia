// services/marketplace/adapters/google.adapter.image-validation.test.js
//
// Regression guard for TASK 2 (image URL validation) and TASK 1 of the
// following run (zero-photo rejection): buildProductInputFromResolved must
// never let an unusable primary image reach Google's Merchant API silently
// — Google accepts a bad OR missing imageLink at insert time and only
// disapproves the product later, off this app's radar, exactly the failure
// shape eBay's own resolveImageUrls already guards against. A product with
// zero photos fails this exact same way, just as reliably as a bad URL —
// both are rejected here now.
//
// Pure unit tests against the exported builder/helper directly — no Mongo,
// no network, matching google.adapter.contract.test.js's own style for the
// adapter's pure building-block functions.
//
// Run with:
//   node --test src/services/marketplace/adapters/google.adapter.image-validation.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const googleAdapter = require("./google.adapter");

const BASE_SETTINGS = { target_country: "AU", content_language: "en", feed_label: "AU" };
const BASE_LISTING = { condition: "new" };

function resolvedWith(photos) {
  return {
    sku: "SKU-IMG-1",
    title: "Test product",
    description: "A test product",
    price: 19.99,
    photos,
    listing: BASE_LISTING,
    product: {},
    variant: null,
  };
}

test("isAbsoluteHttpsUrl: accepts only absolute https:// URLs", () => {
  assert.equal(googleAdapter.isAbsoluteHttpsUrl("https://cdn.example.com/a.jpg"), true);
  assert.equal(googleAdapter.isAbsoluteHttpsUrl("http://cdn.example.com/a.jpg"), false, "plain http must be rejected");
  assert.equal(googleAdapter.isAbsoluteHttpsUrl("/uploads/a.jpg"), false, "a relative path is not absolute");
  assert.equal(googleAdapter.isAbsoluteHttpsUrl("not a url at all"), false);
  assert.equal(googleAdapter.isAbsoluteHttpsUrl(null), false);
  assert.equal(googleAdapter.isAbsoluteHttpsUrl(undefined), false);
  assert.equal(googleAdapter.isAbsoluteHttpsUrl(""), false);
});

test("buildProductInputFromResolved: zero photos throws GoogleImageValidationError (corrected — previously left as a null-imageLink success)", () => {
  const resolved = resolvedWith([]);
  assert.throws(
    () => googleAdapter.buildProductInputFromResolved(resolved, BASE_SETTINGS, 5, {}, "https://store.example.com/product/x"),
    (err) => {
      assert.ok(err instanceof googleAdapter.GoogleImageValidationError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_IMAGE_URL");
      assert.match(err.message, /SKU-IMG-1/, "the error must name the SKU");
      assert.match(err.message, /no images/);
      return true;
    },
  );
});

test("buildProductInputFromResolved: a non-HTTPS primary image throws GoogleImageValidationError naming the SKU, classified as a per-item (400) failure", () => {
  const resolved = resolvedWith([{ url: "http://localhost:7000/uploads/photo.jpg" }]);

  assert.throws(
    () => googleAdapter.buildProductInputFromResolved(resolved, BASE_SETTINGS, 5, {}, "https://store.example.com/product/x"),
    (err) => {
      assert.ok(err instanceof googleAdapter.GoogleImageValidationError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_IMAGE_URL");
      assert.match(err.message, /SKU-IMG-1/, "the error must name the SKU");
      assert.match(err.message, /http:\/\/localhost:7000/);
      return true;
    },
  );
});

test("buildProductInputFromResolved: a relative/malformed primary image URL also throws", () => {
  const resolved = resolvedWith([{ url: "/uploads/photo.jpg" }]);
  assert.throws(
    () => googleAdapter.buildProductInputFromResolved(resolved, BASE_SETTINGS, 5, {}, "https://store.example.com/product/x"),
    googleAdapter.GoogleImageValidationError,
  );
});

test("buildProductInputFromResolved: a usable HTTPS primary image is accepted and sent as imageLink", () => {
  const resolved = resolvedWith([{ url: "https://cdn.example.com/photo1.jpg" }]);
  const input = googleAdapter.buildProductInputFromResolved(resolved, BASE_SETTINGS, 5, {}, "https://store.example.com/product/x");
  assert.equal(input.productAttributes.imageLink, "https://cdn.example.com/photo1.jpg");
  assert.equal(input.productAttributes.additionalImageLinks, undefined);
});

test("buildProductInputFromResolved: a non-HTTPS ADDITIONAL image is dropped, not fatal, and doesn't affect the primary", () => {
  const resolved = resolvedWith([
    { url: "https://cdn.example.com/primary.jpg" },
    { url: "http://cdn.example.com/insecure.jpg" },
    { url: "https://cdn.example.com/secondary.jpg" },
  ]);
  const input = googleAdapter.buildProductInputFromResolved(resolved, BASE_SETTINGS, 5, {}, "https://store.example.com/product/x");
  assert.equal(input.productAttributes.imageLink, "https://cdn.example.com/primary.jpg");
  assert.deepEqual(input.productAttributes.additionalImageLinks, ["https://cdn.example.com/secondary.jpg"]);
});

test("buildProductInputFromResolved: accepts a plain string photo (not just {url})", () => {
  const resolved = resolvedWith(["https://cdn.example.com/plain-string.jpg"]);
  const input = googleAdapter.buildProductInputFromResolved(resolved, BASE_SETTINGS, 5, {}, "https://store.example.com/product/x");
  assert.equal(input.productAttributes.imageLink, "https://cdn.example.com/plain-string.jpg");
});
