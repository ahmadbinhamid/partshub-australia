export type MarketplacePlatform = "ebay" | "google" | "amazon" | "shopify";
export type ListingState = "draft" | "active" | "ended";
export type ListingSyncStatus = "not_listed" | "pending" | "synced" | "out_of_stock" | "price_locked" | "error";

export interface ItemSpecifics {
  brand: string | null;
  mpn: string | null;
  superseded_part_number: string[];
  authenticity: string | null;
  warranty: string | null;
}

export interface FitmentRow {
  make: string;
  model: string;
  model_code: string;
  year_from: number | null;
  year_to: number | null;
}

export interface FitmentRowFormState {
  make: string;
  model: string;
  model_code: string;
  year_from: string;
  year_to: string;
}

export interface PackageDimensions {
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
}

export interface MarketplaceListingProduct {
  _id: string;
  title: string;
  slug: string;
  sku: string | null;
  price: number;
  // Present when the backend populates it (see ebay.listing.service.js's
  // "product" populate field list) — the listing's Technical Specifications
  // always reads this live, never a copy stored on the listing itself.
  vehicle?: import("@/types/product").ProductVehicle | null;
  // Present when the backend populates it — used only as a display fallback
  // when the listing has no photo_overrides of its own (mirrors the
  // product/variant fallback used server-side when actually pushing to eBay,
  // see listing.resolver.js#resolvePhotos). Never written back on save.
  attachments?: import("@/types/product").Attachment[];
}

export interface MarketplaceListing {
  _id: string;
  id: string;
  platform: MarketplacePlatform;
  product: string | MarketplaceListingProduct;
  variant:
    | string
    | null
    | {
        _id: string;
        display_name: string;
        sku: string | null;
        // Same display-fallback purpose as MarketplaceListingProduct.attachments.
        attachments?: import("@/types/product").Attachment[];
      };
  title_override: string | null;
  description_override: string | null;
  price_override: number | null;
  photo_overrides: import("@/types/product").Attachment[];
  state: ListingState;
  sync_status: ListingSyncStatus;
  synced_at: string | null;
  sync_error: string | null;
  external_listing_id: string | null;
  external_offer_id: string | null;
  ebay_item_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface EbayListing extends MarketplaceListing {
  platform: "ebay";
  ebay_category_id: string | null;
  store_category_id: string | null;
  store_sku: string | null;
  condition: string;
  condition_notes: string;
  item_specifics: ItemSpecifics;
  fitment: FitmentRow[];
  format: "FIXED_PRICE" | "AUCTION";
  quantity_available: number | null;
  listing_duration: string;
  accept_best_offer: boolean;
  min_best_offer: number | null;
  fulfillment_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  require_immediate_payment: boolean;
  item_location_zip: string | null;
  package: PackageDimensions;
}

export type GoogleCondition = "new" | "refurbished" | "used";

// Deliberately small — see google.listing.service.js's own module header.
// feed_label/content_language are feed-level settings from the tenant's
// Google connection (chosen once at connect time), never per-listing, so
// they don't appear here even though the backend schema technically has
// unused fields for them.
export interface GoogleListing extends MarketplaceListing {
  platform: "google";
  google_product_category: string | null;
  gtin: string | null;
  mpn: string | null;
  condition: GoogleCondition | null;
  shipping_label: string | null;
}

// The Listings page's main table mixes every platform's rows together (see
// listing.query.service.js) — this is what a row actually is once you don't
// know which platform ahead of time. Narrow with `listing.platform` before
// reading a platform-specific field.
export type AnyMarketplaceListing = EbayListing | GoogleListing;

// Editable fields for the Google "lightweight toggle" flow — see
// components/listings/GoogleListingEditModal.tsx.
export interface GoogleListingFormState {
  google_product_category: string;
  gtin: string;
  mpn: string;
  condition: GoogleCondition | "";
  shipping_label: string;
}

export const GOOGLE_LISTING_FORM_INITIAL: GoogleListingFormState = {
  google_product_category: "",
  gtin: "",
  mpn: "",
  condition: "",
  shipping_label: "",
};

// Form state — all numeric fields kept as strings to avoid controlled-input issues
export interface EbayListingFormState {
  product_id: string;
  variant_id: string;
  title_override: string;
  description_override: string;
  price_override: string;
  photo_overrides: import("@/types/product").Attachment[];
  // Vehicle info is NOT part of the listing's own form state — the
  // Technical Specifications section always reads the product's live
  // `vehicle` field directly (see ebayDescriptionGenerator.ts), so it can
  // never go stale or diverge from the Product page's own data.
  // eBay-specific
  ebay_category_id: string;
  store_category_id: string;
  store_sku: string;
  condition: string;
  condition_notes: string;
  item_specifics: {
    brand: string;
    mpn: string;
    superseded_part_number: string[];
    aspects: Record<string, string>;
    authenticity: string;
    warranty: string;
  };
  fitment: FitmentRowFormState[];
  format: "FIXED_PRICE" | "AUCTION";
  quantity_available: string;
  listing_duration: string;
  accept_best_offer: boolean;
  min_best_offer: string;
  fulfillment_policy_id: string;
  payment_policy_id: string;
  return_policy_id: string;
  require_immediate_payment: boolean;
  item_location_zip: string;
  package: {
    length: string;
    width: string;
    height: string;
    weight: string;
  };
}

export const EBAY_LISTING_FORM_INITIAL: EbayListingFormState = {
  product_id: "",
  variant_id: "",
  title_override: "",
  description_override: "",
  price_override: "",
  photo_overrides: [],
  ebay_category_id: "",
  store_category_id: "",
  store_sku: "",
  condition: "NEW",
  condition_notes: "",
  item_specifics: {
    brand: "",
    mpn: "",
    superseded_part_number: [""],
    aspects: {},
    authenticity: "",
    warranty: "",
  },
  fitment: [],
  format: "FIXED_PRICE",
  quantity_available: "",
  listing_duration: "GTC",
  accept_best_offer: false,
  min_best_offer: "",
  fulfillment_policy_id: "",
  payment_policy_id: "",
  return_policy_id: "",
  require_immediate_payment: true,
  item_location_zip: "",
  package: { length: "", width: "", height: "", weight: "" },
};
