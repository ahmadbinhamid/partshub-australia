import { useEffect, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  ModalFooter,
} from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import type { GoogleListing, GoogleListingFormState } from "@/types/marketplace";
import { GOOGLE_LISTING_FORM_INITIAL } from "@/types/marketplace";

const CONDITION_OPTIONS = [
  { value: "new", label: "New" },
  { value: "refurbished", label: "Refurbished" },
  { value: "used", label: "Used" },
];

function toFormState(listing: GoogleListing): GoogleListingFormState {
  return {
    google_product_category: listing.google_product_category ?? "",
    gtin: listing.gtin ?? "",
    mpn: listing.mpn ?? "",
    condition: listing.condition ?? "",
    shipping_label: listing.shipping_label ?? "",
  };
}

// Google's own edit surface — deliberately just these few fields (see
// google.listing.service.js's module header for why title/description/price/
// photos aren't here: they're inherited from the product itself). A modal
// rather than a dedicated page/route, matching the "lightweight toggle"
// design — there's no eBay-style multi-section form to justify one.
export function GoogleListingEditModal({
  listing,
  open,
  onClose,
  onSave,
  saving,
}: {
  listing: GoogleListing | null;
  open: boolean;
  onClose: () => void;
  onSave: (form: GoogleListingFormState) => void;
  saving?: boolean;
}) {
  const [form, setForm] = useState<GoogleListingFormState>(GOOGLE_LISTING_FORM_INITIAL);

  useEffect(() => {
    if (listing) setForm(toFormState(listing));
  }, [listing]);

  const productTitle =
    listing?.product && typeof listing.product === "object" ? listing.product.title : "this listing";

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="max-w-md">
        <ModalHeader>
          <ModalTitle>Google Shopping details</ModalTitle>
          <ModalDescription>
            Optional attributes for <span className="font-medium text-fg">{productTitle}</span> — title,
            description, price, and photos are always taken from the product itself.
          </ModalDescription>
        </ModalHeader>

        <div className="space-y-4 px-6 py-2">
          <FormField label="Google product category" hint="Google's own taxonomy id or category path.">
            <Input
              value={form.google_product_category}
              onChange={(e) => setForm((f) => ({ ...f, google_product_category: e.target.value }))}
              placeholder="e.g. Vehicles & Parts > Vehicle Parts"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="GTIN" hint="Barcode number, if this part has one.">
              <Input value={form.gtin} onChange={(e) => setForm((f) => ({ ...f, gtin: e.target.value }))} />
            </FormField>
            <FormField label="MPN" hint="Manufacturer part number.">
              <Input value={form.mpn} onChange={(e) => setForm((f) => ({ ...f, mpn: e.target.value }))} />
            </FormField>
          </div>

          <FormField label="Condition">
            <Select
              value={form.condition || undefined}
              onValueChange={(v) => setForm((f) => ({ ...f, condition: v as GoogleListingFormState["condition"] }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Shipping label" hint="Optional — used to route this product to a specific shipping rule in Merchant Center.">
            <Input
              value={form.shipping_label}
              onChange={(e) => setForm((f) => ({ ...f, shipping_label: e.target.value }))}
            />
          </FormField>
        </div>

        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={() => onSave(form)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
