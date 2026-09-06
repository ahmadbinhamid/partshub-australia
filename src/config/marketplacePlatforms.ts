export const PLATFORM_LABEL: Record<string, string> = {
  ebay: "eBay",
  google: "Google Shopping",
  amazon: "Amazon",
  shopify: "Shopify",
};

// Platforms actually wired up end-to-end — amazon/shopify exist in
// PLATFORM_LABEL for future support but have no listing flow yet, so they
// shouldn't appear as choosable channels anywhere in the UI.
export const AVAILABLE_PLATFORMS = ["ebay", "google"];
