// services/product.service.js

const mongoose = require("mongoose");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const Inventory = require("../models/Inventory");
const Location = require("../models/Location");
const MarketplaceListing = require("../models/MarketplaceListing");
const { createWithUniqueSlug, saveWithUniqueSlug } = require("../utils/slug");
const { logger } = require("../loaders/logging");
const { getStockStatus } = require("../utils/stock");
const { toPublicListing, buildProductDisplay } = require("../utils/marketplaceListing");
const { withAttachmentUrls, buildAttachmentFilePath } = require("../utils/attachment");
const inventoryService = require("./inventory.service");
const { getTotalStockForProduct } = inventoryService;
const { getCompanyProfile } = require("./tenantSettings.service");
const emailService = require("./email/email.service");
const { STOCK_STATUS, STOCK_LOW_THRESHOLD } = require("../constants/product.constants");
const { LISTING_STATE } = require("../constants/marketplace.constants");
const { ADJUSTMENT_TYPE } = require("../constants/inventory.constants");

// ── SKU generation ────────────────────────────────────────────────────────────

async function generateNextSku(tenant) {
  // SKUs are zero-padded to 6 digits, so lexicographic desc = numeric desc
  const last = await Product.findOne(
    { tenant_id: tenant._id, sku: new RegExp(`^${tenant.code}-\\d{6}$`) },
    { sku: 1 },
  ).sort({ sku: -1 });

  const num = last?.sku ? parseInt(last.sku.slice(tenant.code.length + 1), 10) : 0;
  return `${tenant.code}-${String(num + 1).padStart(6, "0")}`;
}

// ── Variant generation ────────────────────────────────────────────────────────

function cartesian(arrays) {
  if (!arrays || arrays.length === 0) return [[]];
  return arrays.reduce(
    (acc, curr) => acc.flatMap((a) => curr.map((b) => [...a, b])),
    [[]],
  );
}

async function generateVariantsForProduct(product) {
  if (!product.choices || product.choices.length === 0) return [];

  const optionNames = product.choices.map((c) => c.name);
  const optionValues = product.choices.map((c) => c.items || []);

  const combinations = cartesian(optionValues);
  const existingVariants = await ProductVariant.find({ product: product._id });
  const newVariants = [];

  for (const combo of combinations) {
    const combination = optionNames.map((name, i) => ({
      option: name,
      value: combo[i] || "",
    }));

    const display_name = combo.join(" / ");

    const alreadyExists = existingVariants.find((v) => {
      if (v.combination.length !== combination.length) return false;
      return v.combination.every(
        (c, i) =>
          c.option === combination[i].option &&
          c.value === combination[i].value,
      );
    });

    if (!alreadyExists) {
      const variant = await ProductVariant.create({
        tenant_id: product.tenant_id,
        product: product._id,
        combination,
        display_name,
        price: product.price || 0,
        compare_price: product.compare_price || null,
        cost_price: product.cost_price || null,
      });
      newVariants.push(variant);
    }
  }

  return newVariants;
}

// tenantId is required — without it this queried every tenant's active
// locations, creating an Inventory row for THIS product at every OTHER
// tenant's warehouse/showroom too. Found live during a multi-tenancy audit
// (see backfillTenantId.js's own "found live" history for Location — same
// class of bug, this call site was the one still missing the scope).
async function ensureInventoryForProduct(productId, variantId = null, tenantId) {
  if (!tenantId) throw new Error("[product.service] ensureInventoryForProduct: tenantId is required");
  const locations = await Location.find({ is_active: true, tenant_id: tenantId });
  if (!locations.length) return;

  for (const loc of locations) {
    await Inventory.findOneAndUpdate(
      { product: productId, variant: variantId, location: loc._id },
      {
        $setOnInsert: {
          product: productId,
          variant: variantId,
          location: loc._id,
        },
      },
      { upsert: true, new: true },
    );
  }
}

// ── Product CRUD ──────────────────────────────────────────────────────────────

// Stock is joined in from the separate Inventory collection (aggregation
// can't use Mongoose .populate()), so the whole list query is an aggregation
// pipeline rather than Product.find() — this also lets `stockFilter` match
// against the just-computed stock_count in the same query. Shared by
// getProducts (Mongo-filtered listing) and getProductsByIds (Typesense-ranked
// search results) so both stay in sync on what "in stock" etc. means.
function buildStockStages(stockFilter) {
  const stages = [
    {
      $lookup: {
        from: "inventories",
        localField: "_id",
        foreignField: "product",
        as: "_inventory",
      },
    },
    {
      $addFields: {
        stock_count: {
          $cond: ["$stock_control", { $sum: "$_inventory.stock_count" }, null],
        },
      },
    },
    { $project: { _inventory: 0 } },
  ];

  if (stockFilter === STOCK_STATUS.IN_STOCK) {
    stages.push({
      $match: { $or: [{ stock_control: false }, { stock_count: { $gt: STOCK_LOW_THRESHOLD } }] },
    });
  } else if (stockFilter === STOCK_STATUS.LOW_STOCK) {
    stages.push({
      $match: { stock_control: true, stock_count: { $gt: 0, $lte: STOCK_LOW_THRESHOLD } },
    });
  } else if (stockFilter === STOCK_STATUS.OUT_OF_STOCK) {
    stages.push({
      $match: { stock_control: true, stock_count: { $lte: 0 } },
    });
  }

  return stages;
}

// Joins each product to its active marketplace listings (by platform) so
// `channel` can filter on them — a $lookup rather than a Product-side field
// since a listing's platform lives on MarketplaceListing, not Product.
// $lookup bypasses the soft-delete plugin's find middleware, so deleted_at
// is matched explicitly here.
function buildChannelStages(channel) {
  if (!channel) return [];

  const stages = [
    {
      $lookup: {
        from: "marketplacelistings",
        let: { productId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$product", "$$productId"] },
              state: LISTING_STATE.ACTIVE,
              deleted_at: null,
            },
          },
          { $project: { platform: 1 } },
        ],
        as: "_channelListings",
      },
    },
  ];

  stages.push(
    channel === "none"
      ? { $match: { _channelListings: { $size: 0 } } }
      : { $match: { "_channelListings.platform": channel } },
  );
  stages.push({ $project: { _channelListings: 0 } });

  return stages;
}

// Same reasoning — shared attachment/category hydration for both listing
// paths.
const HYDRATION_STAGES = [
  {
    $lookup: {
      from: "attachments",
      localField: "attachments",
      foreignField: "_id",
      as: "attachments",
      // `url` is a Mongoose virtual, not a stored field — projecting it
      // here is a no-op; it's backfilled below via withAttachmentUrls().
      pipeline: [
        { $project: { original_name: 1, mime_type: 1, type: 1, uid: 1, file_name: 1 } },
      ],
    },
  },
  {
    $lookup: {
      from: "categories",
      localField: "categories",
      foreignField: "_id",
      as: "categories",
      pipeline: [{ $project: { name: 1, slug: 1 } }],
    },
  },
];

function withComputedFields(p) {
  return {
    ...p,
    // $lookup fetches raw attachment docs, bypassing the Attachment model's
    // `url` virtual entirely — backfill it explicitly.
    attachments: withAttachmentUrls(p.attachments),
    stock_status: getStockStatus(p.stock_count, p.stock_control),
  };
}

async function getProducts(filter, { skip, limit, sort = { created_at: -1 }, stockFilter, channelFilter } = {}) {
  const basePipeline = [
    { $match: filter },
    ...buildStockStages(stockFilter),
    ...buildChannelStages(channelFilter),
  ];

  const countPipeline = [...basePipeline, { $count: "total" }];
  const pipeline = [
    ...basePipeline,
    { $sort: sort },
    { $skip: skip },
    { $limit: limit },
    ...HYDRATION_STAGES,
  ];

  const [items, countResult] = await Promise.all([
    Product.aggregate(pipeline),
    Product.aggregate(countPipeline),
  ]);

  return {
    items: items.map(withComputedFields),
    total: countResult[0]?.total || 0,
  };
}

// Search-driven listing: `ids` is a relevance-ordered candidate set already
// produced by Typesense (see product.search.service.js#searchProducts) and
// already scoped to tenant/published/structured filters — this only adds the
// stock join/filter (not indexed in Typesense) and re-sorts to match
// Typesense's relevance order, since $in does not preserve array order.
async function getProductsByIds(ids, { stockFilter, channelFilter } = {}) {
  if (!ids.length) return { items: [] };

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const pipeline = [
    { $match: { _id: { $in: objectIds } } },
    ...buildStockStages(stockFilter),
    ...buildChannelStages(channelFilter),
    ...HYDRATION_STAGES,
  ];

  const items = await Product.aggregate(pipeline);
  const byId = new Map(items.map((p) => [p._id.toString(), p]));

  return {
    items: ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map(withComputedFields),
  };
}

async function findProductById(id, tenantId) {
  return Product.findOne({ _id: id, tenant_id: tenantId });
}

// Adds a staff comment to a product's internal notes thread — never shown
// to customers. Mirrors order.service.js#addOrderNote exactly.
async function addProductNote(productId, { text, userId }, tenantId) {
  const product = await Product.findOne({ _id: productId, tenant_id: tenantId });
  if (!product) return null;

  product.internal_notes.push({ text, author: userId || null, created_at: new Date() });
  await product.save();
  return product;
}

// Emails a product's title/SKU to a recipient the admin picks, with every
// product image attached — triggered by the "Send Email" action beside Add
// to Cart on the product edit page. Attachments are handed to nodemailer by
// disk path rather than base64 — see buildAttachmentFilePath.
async function sendProductInfoEmail(productId, { name, email }, tenantId) {
  const product = await getPopulatedProduct(productId, tenantId);
  if (!product) return null;

  const companyProfile = await getCompanyProfile(tenantId);
  const attachments = (product.attachments || [])
    .filter((att) => att.file_name)
    .map((att) => ({
      filename: att.original_name || att.file_name,
      path: buildAttachmentFilePath(att.file_name),
      contentType: att.mime_type || undefined,
    }));

  await emailService.sendProductInfo({
    to: email,
    name,
    productTitle: product.title,
    productSku: product.sku,
    attachments,
    companyProfile,
    tenantId,
  });

  return product;
}

async function getProductBySlug(slug, tenantId) {
  const product = await Product.findOne({ slug, tenant_id: tenantId })
    .populate("attachments")
    .populate("categories")
    .populate("digital_file")
    .populate("related_products", "title slug price attachments")
    .lean();
  if (!product) return null;

  // .lean() returns a plain object, so the Attachment model's `url` virtual
  // never runs here either — backfill it explicitly, same as the list endpoint.
  product.attachments = withAttachmentUrls(product.attachments);

  product.stock_count = product.stock_control
    ? await getTotalStockForProduct(product._id)
    : null;
  product.stock_status = getStockStatus(product.stock_count, product.stock_control);

  // internal_notes was added to the schema after existing products were
  // created — .lean() returns the raw stored document with no schema
  // defaults applied (unlike a hydrated Mongoose document), so any product
  // saved before this field existed comes back with the key missing entirely.
  product.internal_notes = product.internal_notes ?? [];

  // Active marketplace listings (currently only eBay) carry storefront-useful
  // content — warranty, condition notes, fitment — layered on top of the
  // product record. A product can have more than one (per platform/variant),
  // so this is always an array, even though today it's usually 0 or 1 item.
  const listings = await MarketplaceListing.find({
    product: product._id,
    state: LISTING_STATE.ACTIVE,
  })
    .populate("photo_overrides", "file_name")
    .lean();
  // Same .lean()-strips-virtuals issue as above, for each listing's photos.
  listings.forEach((listing) => {
    listing.photo_overrides = withAttachmentUrls(listing.photo_overrides);
  });

  // `display` resolves the "which value wins" precedence (listing override
  // vs. the product's own value) and merges/dedupes vehicle fitment — the
  // frontend renders this as-is rather than re-deriving it. `listings` stays
  // available too, for fields with no product-level counterpart to resolve
  // against (superseded part numbers, raw item specifics, photos).
  product.display = buildProductDisplay(product, listings);
  product.listings = listings.map(toPublicListing);

  return product;
}

async function getPopulatedProduct(id, tenantId) {
  return Product.findOne({ _id: id, tenant_id: tenantId })
    .populate("attachments")
    .populate("categories")
    .populate("digital_file");
}

// Retries on a genuine slug conflict instead of trusting a single
// check-then-insert (see utils/slug.js for why).
async function createProductRecordWithSlug(data, baseSlug, tenantId) {
  return createWithUniqueSlug(Product, baseSlug, (slug) => ({ ...data, tenant_id: tenantId, slug }), { tenantId });
}

// ── Variant CRUD ──────────────────────────────────────────────────────────────

async function getVariantsByProduct(productId, tenantId) {
  return ProductVariant.find({ product: productId, tenant_id: tenantId })
    .populate("attachments")
    .populate("digital_file")
    .sort({ display_name: 1 });
}

async function findVariant(variantId, productId, tenantId) {
  return ProductVariant.findOne({ _id: variantId, product: productId, tenant_id: tenantId });
}

// Lean id-only lookup for marketplace fan-out (product.controller.js#updateProduct)
// — unlike getVariantsByProduct above, this never needs the populated
// attachments/digital_file, just which variant ids exist so each one's own
// listings can be fanned out to individually.
async function listVariantIdsForProduct(productId, tenantId) {
  const variants = await ProductVariant.find({ product: productId, tenant_id: tenantId })
    .select("_id")
    .lean();
  return variants.map((v) => v._id);
}

async function getPopulatedVariant(id, tenantId) {
  return ProductVariant.findOne({ _id: id, tenant_id: tenantId })
    .populate("attachments")
    .populate("digital_file");
}

async function hasMarketplaceListings(productId) {
  return MarketplaceListing.exists({ product: productId });
}

async function saveProduct(product) {
  return product.save();
}

// For renames: retries on a genuine slug conflict instead of trusting a
// single check-then-save (see utils/slug.js for why).
async function saveProductWithUniqueSlug(product, baseSlug) {
  return saveWithUniqueSlug(product, Product, baseSlug, product._id.toString(), { tenantId: product.tenant_id });
}

async function softDeleteProduct(product) {
  return product.softDelete();
}

async function saveVariant(variant) {
  return variant.save();
}

// Routed through inventory.service#adjustStock (rather than a raw
// Inventory.updateOne) so the opening quantity set at product creation
// shows up in that inventory record's stock history — same as every other
// stock change (manual adjust, sale, refund, eBay sync). Without this, a
// product created with e.g. 50 units on hand would read "No stock changes
// recorded yet." in the History sheet despite genuinely having stock.
async function applyStockEntries(productId, stockEntries, { tenantId, userId } = {}) {
  for (const entry of stockEntries) {
    if (entry.qty > 0) {
      const record = await Inventory.findOne({
        product: productId,
        variant: null,
        location: entry.location_id,
      });
      if (!record) continue;

      await inventoryService.adjustStock(record, {
        adjustment: entry.qty,
        reason: "Opening stock on product creation",
        type: ADJUSTMENT_TYPE.RESTOCK,
        userId,
        tenantId,
      });
    }
  }
}

// Lightweight hydration for the autocomplete dropdown — `ids` is the
// relevance-ordered set Typesense returned (see
// product.search.service.js#suggestProducts); only the fields a suggestion
// row actually renders are selected/populated.
async function getProductSuggestions(ids) {
  if (!ids.length) return [];

  const products = await Product.find({ _id: { $in: ids } })
    .select("title slug sku mpn price attachments")
    .populate("attachments", "original_name mime_type type uid file_name")
    .lean();

  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => ({ ...p, attachments: withAttachmentUrls(p.attachments) }));
}

module.exports = {
  cartesian,
  generateNextSku,
  generateVariantsForProduct,
  ensureInventoryForProduct,
  getProducts,
  getProductsByIds,
  getProductSuggestions,
  findProductById,
  addProductNote,
  sendProductInfoEmail,
  getProductBySlug,
  getPopulatedProduct,
  createProductRecordWithSlug,
  getVariantsByProduct,
  listVariantIdsForProduct,
  findVariant,
  getPopulatedVariant,
  hasMarketplaceListings,
  saveProduct,
  saveProductWithUniqueSlug,
  softDeleteProduct,
  saveVariant,
  applyStockEntries,
};
