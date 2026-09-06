import { apiClient } from "./client";
import type { BeResponse } from "./base";
import type {
  GoogleConnectUrlResponse,
  GoogleAccountsResponse,
  GoogleCompleteConnectPayload,
} from "@/types/googleSettings";

// Returns Google's hosted consent-screen URL — the caller navigates the
// browser there directly (window.location.href), it's not fetched via XHR,
// mirroring getEbayConnectUrl. TASK 4: no params any more — consent happens
// before the tenant has chosen a Merchant Center account at all (see
// controllers/google.controller.js#getConnectUrl).
export const getGoogleConnectUrl = async () => {
  const { data } = await apiClient.get<BeResponse<GoogleConnectUrlResponse>>("/google/oauth/connect-url");
  return data;
};

// Called after landing back with ?google_connect=choose_account — the
// Merchant Center accounts this tenant's just-granted token can access,
// for the account-picker dropdown.
export const getGoogleAccounts = async () => {
  const { data } = await apiClient.get<BeResponse<GoogleAccountsResponse>>("/google/oauth/accounts");
  return data;
};

// Finishes the connect flow once the tenant has picked (or typed) a
// Merchant Center account and confirmed feed settings.
export const completeGoogleConnect = async (payload: GoogleCompleteConnectPayload) => {
  const { data } = await apiClient.post<BeResponse<{ connected: boolean }>>("/google/oauth/complete", payload);
  return data;
};
