import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Landmark, MapPin, Phone, Mail, User, Truck, ClipboardList, Shield, Scale, Heart } from "lucide-react";
import { TenantLogo } from "@/components/branding/TenantLogo";
import { getTenantSettings } from "@/lib/api/tenantSettings";
import { formatCurrencyFromCents, getExclusiveUnitPrice, getLineGst, formatOrderNumber, formatInvoiceNumber } from "@/utils/format";
import { getTotalPaid, getBalanceDue, getTotalRefunded } from "@/utils/paymentTotals";
import type { OrderDetail } from "@/types/orders";

// Print-only invoice, structured to match the tax-invoice PDF attached to
// the pickup-ready/shipped emails (order.service.js#sendOrderNotification)
// — same sections, same fields — so a printed copy and the emailed copy
// never disagree. Deliberately hardcoded to light/print-safe colors (not
// the app's theme tokens) since this must stay legible on paper regardless
// of whether the dashboard is in dark mode when "Print Invoice" is clicked.
// (This is also why the payment-status badge below is hand-styled rather
// than the shared <Badge> component, which pulls in theme-aware tokens.)

const INK = "#18140f";
const MUTED = "#6b6f7a";
const ACCENT = "#c2790b";
const BORDER = "#e2e0da";
const TINT_BG = "#f6efe4";
const GREEN = "#16a34a";
const GREEN_BG = "#eaf6ec";

const PAYMENT_STATUS_STYLES: Record<string, { label: string; bg: string }> = {
  paid: { label: "Paid", bg: GREEN },
  partially_paid: { label: "Partially Paid", bg: "#d97706" },
  pending_payment: { label: "Pending", bg: "#6b7280" },
  partially_refunded: { label: "Partially Refunded", bg: "#d97706" },
  refunded: { label: "Refunded", bg: "#6b7280" },
};

function StatusBadge({ status }: { status: string }) {
  const style = PAYMENT_STATUS_STYLES[status] ?? PAYMENT_STATUS_STYLES.pending_payment;
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white"
      style={{ background: style.bg }}
    >
      {style.label}
    </span>
  );
}

function ColumnHeading({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: ACCENT }}>
      <Icon className="h-3.5 w-3.5" style={{ color: ACCENT }} />
      {children}
    </div>
  );
}

function ContactLine({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px]" style={{ color: INK }}>
      <Icon className="h-4 w-4 shrink-0" style={{ color: INK }} />
      <span>{children}</span>
    </div>
  );
}

function HeaderMetaRow({ label, value, mutedValue = false }: { label: string; value: string; mutedValue?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
        {label}
      </span>
      <span className="text-xs" style={{ color: mutedValue ? MUTED : INK, fontWeight: mutedValue ? 400 : 700 }}>
        {value}
      </span>
    </div>
  );
}

export function InvoicePrintView({ order }: { order: OrderDetail }) {
  const { data: tenantSettingsData } = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });
  const tenant = tenantSettingsData?.data;

  const isPickup = order.delivery_method === "pickup";
  const amountPaid = getTotalPaid(order.payments);
  const totalRefunded = getTotalRefunded(order.payments);
  // Item-level discounts plus any legacy order-level discount (see Order.js's
  // discount_amount comment) — order.subtotal already nets these out.
  const itemDiscount = order.items.reduce((sum, i) => sum + i.discount_amount, 0);
  const totalDiscount = itemDiscount + order.discount_amount;
  // order.tax_amount is the authoritative GST embedded in order.subtotal
  // (computed once at order-creation time from the POST-discount subtotal —
  // order.service.js#GST_DIVISOR) — reused directly, matching
  // invoicePdf.js's identical convention, so the emailed/downloaded PDF and
  // this on-screen preview can never disagree about GST.
  const gstAmount = order.tax_amount;
  const exGstSubtotal = order.subtotal - gstAmount;
  // See utils/paymentTotals.ts#getBalanceDue — correctly distinguishes "paid
  // in full, then refunded" (due $0) from "never paid in full, then refunded
  // on top of that" (due reflects the real remaining shortfall).
  const amountDue = getBalanceDue(order.total, order.payments, order.payment_status);
  const orderDate = new Date(order.created_at).toLocaleDateString("en-AU", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  // Rendered at print/PDF-build time, not stored — matches invoicePdf.js,
  // which stamps the same "as of right now" timestamp server-side.
  const printedAt = new Date().toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const billingAddress = order.billing_address ?? order.shipping_address;
  const channelLabel = order.channel === "ebay" ? "eBay" : order.channel === "manual" ? "In-Store" : "Storefront";
  const orderNumberValue = order.reference_number || formatOrderNumber(order.order_number_prefix, order.order_number);
  // Free-text field — rendered as a bullet list when the tenant typed it as
  // separate lines, otherwise as a plain paragraph exactly as before. No
  // schema change: this is purely how the existing string is displayed.
  const warrantyLines = (tenant?.warranty_text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div
      // print:block — same fix as AppShell.tsx's shell containers: a flex
      // column doesn't fragment across printed pages, so on a multi-page
      // invoice this whole card (and the mt-auto footer's "push to the very
      // bottom" behavior below) has to stop being a flexbox once printing.
      className="flex min-h-[270mm] flex-col rounded-[10px] border p-7 print:block"
      style={{ borderColor: BORDER, color: INK, background: "#ffffff" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-6 border-b pb-6" style={{ borderColor: BORDER }}>
        <div className="flex items-start gap-4">
          <TenantLogo logoUrl={tenant?.logo_url} name={tenant?.company_name} sizeClass="h-14" maxWidthClass="max-w-[60px]" />
          <div>
            <h2 className="text-2xl font-black uppercase tracking-tight">{tenant?.company_name || "—"}</h2>
            <ContactLine icon={MapPin}>
              {tenant?.pickup_location.address}
              {tenant?.pickup_location.address && tenant?.pickup_location.country ? ", " : ""}
              {tenant?.pickup_location.country}
            </ContactLine>
            {tenant?.phone && <ContactLine icon={Phone}>{tenant.phone}</ContactLine>}
            {tenant?.email && <ContactLine icon={Mail}>{tenant.email}</ContactLine>}
            <div className="mt-2 flex items-center gap-2">
              <span
                className="rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                style={{ borderColor: BORDER, color: MUTED }}
              >
                ABN
              </span>
              <span className="text-xs font-semibold" style={{ color: INK }}>
                {tenant?.abn || "—"}
              </span>
            </div>
          </div>
        </div>
        <div className="text-right" style={{ minWidth: 240 }}>
          <h1 className="text-3xl font-black uppercase tracking-tight">Tax Invoice</h1>
          <div className="mt-2 inline-block rounded-full px-3 py-1 text-sm font-bold text-white" style={{ background: ACCENT }}>
            {formatInvoiceNumber(order.invoice_number_prefix, order.invoice_number)}
          </div>
          <div className="mt-3 rounded-lg border text-left" style={{ borderColor: BORDER }}>
            <div className="px-3 py-2">
              <HeaderMetaRow label="Invoice Date" value={orderDate} />
            </div>
            <div className="border-t px-3 py-2" style={{ borderColor: BORDER }}>
              <HeaderMetaRow label="Due Date" value="Upon Receipt" />
            </div>
            <div className="border-t px-3 py-2" style={{ borderColor: BORDER }}>
              <HeaderMetaRow label="Printed" value={printedAt} mutedValue />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 py-6 sm:grid-cols-3">
        <div>
          <ColumnHeading icon={User}>Bill To</ColumnHeading>
          <div className="mt-2.5 text-sm font-bold">{order.customer.company_name || order.customer.name}</div>
          <div className="mt-1.5 space-y-0.5 text-xs" style={{ color: MUTED }}>
            {billingAddress && <div>{billingAddress.address}</div>}
            {billingAddress && (
              <div>
                {billingAddress.suburb} {billingAddress.state} {billingAddress.postcode}, Australia
              </div>
            )}
            {order.customer.phone && <div>PH: {order.customer.phone}</div>}
            {order.customer.email && <div>EMAIL: {order.customer.email}</div>}
          </div>
        </div>

        <div>
          <ColumnHeading icon={Truck}>Ship To</ColumnHeading>
          <div className="mt-2.5 text-sm font-bold">{order.customer.company_name || order.customer.name}</div>
          <div className="mt-1.5 space-y-0.5 text-xs" style={{ color: MUTED }}>
            {isPickup || !order.shipping_address ? (
              <div>Collecting in-store — see seller address above.</div>
            ) : (
              <>
                <div>{order.shipping_address.address}</div>
                <div>
                  {order.shipping_address.suburb} {order.shipping_address.state} {order.shipping_address.postcode}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="rounded-lg p-4" style={{ background: TINT_BG }}>
          <ColumnHeading icon={ClipboardList}>Order Information</ColumnHeading>
          <div className="mt-3 space-y-2.5">
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                Order Number
              </div>
              <div className="text-sm font-bold">{orderNumberValue}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                Sales Channel
              </div>
              <div className="text-sm font-bold">{channelLabel}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                Payment Status
              </div>
              <div className="mt-0.5">
                <StatusBadge status={order.payment_status} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border" style={{ borderColor: BORDER }}>
        <table className="w-full border-collapse text-sm">
          {/* table-header-group repeats this row on every printed page the
              table spans, so a row that lands on page 2 isn't unlabeled. */}
          <thead style={{ display: "table-header-group" }}>
            <tr style={{ background: TINT_BG }}>
              <th className="w-10 px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                #
              </th>
              <th className="px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                Description / Item Code
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                Unit Price (ex GST)
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                GST (11%)
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                Qty
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                Discount
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
                Total (inc GST)
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item, i) => {
              // GST-inclusive AU retail pricing: extracted as total/11, never
              // added on top of unit_price — see utils/format.ts#getLineGst.
              const lineTotal = item.unit_price * item.quantity - item.discount_amount;
              const lineGst = getLineGst(lineTotal);
              return (
                <tr
                  key={i}
                  className="border-b last:border-b-0"
                  // Without this, the browser's print pagination can slice a
                  // row in half across a page boundary (reported: a long
                  // item name got cut off mid-line). pageBreakInside is the
                  // older alias some print engines still need alongside the
                  // standard breakInside property.
                  style={{ borderColor: BORDER, breakInside: "avoid", pageBreakInside: "avoid" }}
                >
                  <td className="px-3 py-3 align-top text-xs" style={{ color: MUTED }}>
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="font-semibold">{item.name}</div>
                    {item.sku && (
                      <div className="mt-0.5 text-xs" style={{ color: MUTED }}>
                        Part SKU: {item.sku}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    {formatCurrencyFromCents(getExclusiveUnitPrice(item.unit_price))}
                  </td>
                  <td className="px-3 py-3 text-right align-top">{formatCurrencyFromCents(lineGst)}</td>
                  <td className="px-3 py-3 text-right align-top">{item.quantity}</td>
                  <td className="px-3 py-3 text-right align-top">{formatCurrencyFromCents(item.discount_amount)}</td>
                  <td className="px-3 py-3 text-right align-top font-semibold">{formatCurrencyFromCents(lineTotal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-8 pt-8 sm:grid-cols-2 print:block">
        <div
          className="print:inline-block print:w-[47%] print:align-top"
          style={{ breakInside: "avoid", pageBreakInside: "avoid" }}
        >
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: MUTED }}>
            <Landmark className="h-3.5 w-3.5" />
            Payment Details
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                Bank Name
              </div>
              <div className="font-semibold">{tenant?.bank_details.bank_name || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                Account Name
              </div>
              <div className="font-semibold">{tenant?.bank_details.account_name || tenant?.company_name || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                BSB
              </div>
              <div className="font-semibold">{tenant?.bank_details.bsb || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
                Account No
              </div>
              <div className="font-semibold">{tenant?.bank_details.account_number || "—"}</div>
            </div>
          </div>
        </div>

        <div
          className="space-y-1.5 text-sm print:inline-block print:w-[47%] print:ml-[4%] print:align-top"
          style={{ breakInside: "avoid", pageBreakInside: "avoid" }}
        >
          {/* Pre-discount subtotal + the discount itself only earn a line
              when there actually is a discount — an order with none goes
              straight from Subtotal (Ex GST) to GST to Freight, matching a
              clean invoice with nothing to net out. */}
          {totalDiscount > 0 && (
            <>
              <div className="flex justify-between gap-3">
                <span style={{ color: MUTED }}>Subtotal</span>
                <span className="whitespace-nowrap font-semibold">
                  {formatCurrencyFromCents(order.subtotal + totalDiscount)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span style={{ color: MUTED }}>Discount</span>
                <span className="whitespace-nowrap font-semibold">-{formatCurrencyFromCents(totalDiscount)}</span>
              </div>
            </>
          )}
          <div className="flex justify-between gap-3">
            <span className="whitespace-nowrap" style={{ color: MUTED }}>
              Subtotal <span className="text-[10px]">(Ex GST)</span>
            </span>
            <span className="whitespace-nowrap font-semibold">{formatCurrencyFromCents(exGstSubtotal)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: MUTED }}>GST (11%)</span>
            <span className="whitespace-nowrap font-semibold">{formatCurrencyFromCents(gstAmount)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: MUTED }}>{isPickup ? "Pickup" : "Freight / Shipping"}</span>
            <span className="whitespace-nowrap font-semibold">{formatCurrencyFromCents(order.shipping_cost)}</span>
          </div>
          <div className="flex justify-between gap-3 border-t pt-2 text-base" style={{ borderColor: BORDER }}>
            <span className="whitespace-nowrap font-bold">
              TOTAL <span className="text-xs font-normal" style={{ color: MUTED }}>(Inc GST)</span>
            </span>
            <span className="whitespace-nowrap font-bold" style={{ color: ACCENT }}>
              {formatCurrencyFromCents(order.total)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: MUTED }}>Total Paid</span>
            <span className="whitespace-nowrap font-semibold">{formatCurrencyFromCents(amountPaid)}</span>
          </div>
          {totalRefunded > 0 && (
            <div className="flex justify-between gap-3">
              <span style={{ color: MUTED }}>Total Refunded</span>
              <span className="whitespace-nowrap font-semibold">{formatCurrencyFromCents(totalRefunded)}</span>
            </div>
          )}
          {amountDue === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: GREEN_BG }}>
              <span className="font-medium" style={{ color: GREEN }}>
                Total Due
              </span>
              <span className="whitespace-nowrap font-semibold" style={{ color: GREEN }}>
                {formatCurrencyFromCents(amountDue)}
              </span>
            </div>
          ) : (
            <div className="flex justify-between gap-3">
              <span style={{ color: MUTED }}>Total Due</span>
              <span className="whitespace-nowrap font-semibold">{formatCurrencyFromCents(amountDue)}</span>
            </div>
          )}

          {/* Every channel can carry an outstanding balance now that
              storefront/eBay prices can be edited post-payment — not just
              manual sales, so this is no longer gated on order.channel.
              Only rendered when there's an actual balance (amountDue > 0) —
              getBalanceDue already correctly returns 0 for an order that was
              paid in full before being refunded, so no separate refunded-
              status check is needed here. */}
          {amountDue > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-4 py-3" style={{ background: ACCENT }}>
              <span className="whitespace-nowrap text-xs font-bold uppercase tracking-wider text-white">
                Balance Outstanding
              </span>
              <span className="whitespace-nowrap text-sm font-bold text-white">
                {formatCurrencyFromCents(amountDue)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Full-width, below both columns — was previously squeezed inline
          into the payment-details column only. */}
      {amountPaid > 0 ? (
        <div className="mt-6 flex items-center justify-center gap-2 rounded-lg px-4 py-3" style={{ background: GREEN_BG }}>
          <CheckCircle2 className="h-4.5 w-4.5" style={{ color: GREEN }} />
          <span className="text-sm font-bold uppercase tracking-wide" style={{ color: GREEN }}>
            Payment Received via {channelLabel}
          </span>
        </div>
      ) : (
        <div
          className="mt-6 flex items-center justify-center gap-2 rounded-lg px-4 py-3"
          style={{ background: TINT_BG }}
        >
          <Clock className="h-4.5 w-4.5" style={{ color: MUTED }} />
          <span className="text-sm font-bold uppercase tracking-wide" style={{ color: MUTED }}>
            No Payment Recorded Yet
          </span>
        </div>
      )}

      <div
        // mt-auto only makes sense while the card above is a flex column
        // (pins this to the visual bottom of one page on screen) — once
        // print:block turns off flex layout for a multi-page invoice, auto
        // margin has nothing to size against and instead pushes this box all
        // the way past the end of every page's content, leaving a huge blank
        // gap before it. print:mt-8 swaps it for a plain fixed gap on print.
        className="mt-auto print:mt-8"
      >
        <div
          // print:block + inline-block columns, instead of keeping this a
          // CSS grid at print time — see each column's own breakInside
          // comment for why that guard lives on the column, not this wrapper.
          className="grid gap-6 text-xs sm:grid-cols-2 print:block"
          style={{ color: MUTED }}
        >
          <div
            className="rounded-lg border p-4 print:inline-block print:w-[47%] print:align-top"
            // Keeps this column's own content from splitting mid-sentence
            // across a page boundary (reported: "...returns." got orphaned
            // alone on its own page).
            style={{ borderColor: BORDER, breakInside: "avoid", pageBreakInside: "avoid" }}
          >
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: INK }}>
              <Shield className="h-3.5 w-3.5" style={{ color: ACCENT }} />
              Warranty &amp; Returns
            </div>
            {warrantyLines.length > 1 ? (
              <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
                {warrantyLines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 leading-relaxed">{tenant?.warranty_text || "—"}</p>
            )}
          </div>
          <div
            className="rounded-lg border p-4 print:inline-block print:w-[47%] print:ml-[4%] print:align-top"
            style={{ borderColor: BORDER, breakInside: "avoid", pageBreakInside: "avoid" }}
          >
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: INK }}>
              <Scale className="h-3.5 w-3.5" style={{ color: ACCENT }} />
              Legal Disclaimer
            </div>
            <p className="mt-1.5 leading-relaxed">{tenant?.legal_disclaimer_text || "—"}</p>
          </div>
        </div>

        <div className="mt-6 text-center" style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
          <div className="flex items-center justify-center gap-2">
            <Heart className="h-4 w-4" style={{ color: ACCENT }} fill={ACCENT} />
            <span className="text-sm font-bold" style={{ color: INK }}>
              Thank You For Your Business!
            </span>
          </div>
          <div className="mt-1 text-xs" style={{ color: MUTED }}>
            We appreciate your support.
          </div>
        </div>
      </div>
    </div>
  );
}
