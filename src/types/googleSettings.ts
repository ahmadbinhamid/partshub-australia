// Google Shopping (Merchant API) connect flow — mirrors types/ebaySettings.ts's
// shape. TASK 4: consent now happens FIRST, with no merchant fields needed
// up front — see server/docs/channel-architecture.md §9 (connect flow) and
// services/google/google.oauth.service.js's own module comments for why.
// The tenant picks a Merchant Center account from a dropdown (or, if that
// isn't available for this token, types one in) only AFTER granting
// consent — GoogleConnectAccount/GoogleAccountsResponse/GoogleCompleteConnectPayload
// below are that second step.

export interface GoogleConnectUrlResponse {
  url: string;
}

export interface GoogleConnectAccount {
  accountId: string;
  accountName: string | null;
}

export interface GoogleAccountsResponse {
  accounts: GoogleConnectAccount[];
  // false when accounts.list itself wasn't usable for this token (see
  // google.controller.js#getAccounts) — the UI falls back to a manual
  // Merchant Center ID field rather than a dropdown when this is false.
  listSupported: boolean;
  message?: string;
}

export interface GoogleCompleteConnectPayload {
  merchantId: string;
  targetCountry: string;
  // Optional — google.controller.js#completeConnect defaults these
  // server-side (targetCountry / "en") when omitted.
  feedLabel?: string;
  contentLanguage?: string;
}
