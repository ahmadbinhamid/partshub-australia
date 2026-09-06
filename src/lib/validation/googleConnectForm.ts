import { z } from "zod";

// targetCountry is constrained to what google.adapter.js#COUNTRY_CURRENCY
// actually maps to a real currency — anything outside this list silently
// falls back to USD server-side, which is worse than just not offering it
// as an option here.
export const GOOGLE_TARGET_COUNTRIES = [
  { value: "AU", label: "Australia (AUD)" },
  { value: "US", label: "United States (USD)" },
  { value: "GB", label: "United Kingdom (GBP)" },
  { value: "NZ", label: "New Zealand (NZD)" },
  { value: "CA", label: "Canada (CAD)" },
] as const;

// TASK 4: step 2 of the connect flow (after OAuth consent) — merchantId is
// either the account chosen from the dropdown or, only when accounts.list
// wasn't usable for this token, typed in manually. feedLabel/contentLanguage
// are optional here too (server defaults them the same way) — an empty
// string is treated the same as "use the default", not a validation error.
export const googleCompleteConnectFormSchema = z.object({
  merchantId: z.string().trim().min(1, "Choose (or enter) a Merchant Center account"),
  targetCountry: z.string().trim().min(1, "Target country is required"),
  feedLabel: z.string().trim().optional(),
  contentLanguage: z.string().trim().optional(),
});

export type GoogleCompleteConnectFormValues = z.infer<typeof googleCompleteConnectFormSchema>;
