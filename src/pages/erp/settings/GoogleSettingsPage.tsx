import { PageHeader } from "@/components/shared/PageHeader";
import { GoogleConnectCard } from "@/components/google-settings/GoogleConnectCard";

// Mirrors EbaySettingsPage's shape. Simpler than eBay's page for now: there
// is no GET/PUT /google/settings endpoint yet (only the OAuth connect-url
// call — see types/googleSettings.ts's own comment), so there's no
// post-connect settings form to render here the way EbaySettingsForm exists
// for eBay. GoogleConnectCard's own feed-settings inputs are the only
// editable surface until that endpoint exists.
export default function GoogleSettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Google Shopping"
        description="Connect a Google Merchant Center account and configure feed defaults."
      />

      <GoogleConnectCard />
    </div>
  );
}
