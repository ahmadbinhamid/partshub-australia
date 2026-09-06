import { apiClient } from "./client";
import type { BeResponse } from "./base";
import type { GoogleListing, GoogleListingFormState } from "@/types/marketplace";

// Google's "lightweight toggle" create — much smaller than eBay's
// createListing (lib/api/listings.ts) since most of a Google listing's data
// comes straight from the product itself (see google.listing.service.js's
// own module header). Creating ALSO queues the listing for its first sync
// server-side (google.listing.controller.js) — there's no separate push
// step the way eBay's flow has one.
export const createGoogleListing = async (productId: string, variantId: string | null, form: GoogleListingFormState) => {
  const { data } = await apiClient.post<BeResponse<GoogleListing>>("/google/listings", {
    product: productId,
    variant: variantId,
    google_product_category: form.google_product_category || null,
    gtin: form.gtin || null,
    mpn: form.mpn || null,
    condition: form.condition || null,
    shipping_label: form.shipping_label || null,
  });
  return data;
};

export const updateGoogleListing = async (id: string, form: GoogleListingFormState) => {
  const { data } = await apiClient.put<BeResponse<GoogleListing>>(`/google/listings/${id}`, {
    google_product_category: form.google_product_category || null,
    gtin: form.gtin || null,
    mpn: form.mpn || null,
    condition: form.condition || null,
    shipping_label: form.shipping_label || null,
  });
  return data;
};
