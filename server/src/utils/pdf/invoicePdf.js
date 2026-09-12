// utils/pdf/invoicePdf.js
//
// Renders a Tax Invoice PDF for an order, generated server-side with pdfkit
// since this is headless (an email attachment), not the browser's print
// dialog. Palette, fonts, and layout are kept in lockstep with the
// dashboard's InvoicePrintView.tsx (the "Print Invoice" button) — same
// light theme, same colors, same field order — so the emailed PDF and the
// printed copy never disagree. pdfkit has no SVG/icon-font support, so
// every icon here is hand-drawn with vector primitives rather than pulled
// from an icon set (InvoicePrintView uses lucide-react icons directly since
// it renders in a browser) — new icons added in this file deliberately stay
// simple (small filled circles) rather than hand-tracing something like a
// truck or scale glyph with no way to visually verify the result before it
// ships; only the check and heart icons (forgiving shapes even when rough)
// get an actual hand-drawn glyph.

const path = require("path");
const PDFDocument = require("pdfkit");
const { ORDER_DELIVERY_METHOD } = require("../../constants/order.constants");
const { formatOrderNumber, formatInvoiceNumber } = require("../orderNumberFormat");

const PAGE_MARGIN = 54;
const FRAME_PADDING = 20; // gap between the card border and its content
const CARD_RADIUS = 10;
// Column starts/widths must sum to <= CONTENT_WIDTH (487.28pt at the current
// PAGE_MARGIN) — seven columns: a row-number column plus GST/Qty/Discount
// each broken out as their own correctly-labeled column (order.tax_amount is
// only ever an order-level figure, so it can't answer "what's the GST on
// this specific line"). `total`'s width is deliberately short of the
// remaining space so its right-aligned text never sits flush against the
// table's outer border (every other column already gets this breathing
// room for free, via the 5pt gap before the next column).
const COLUMNS = { number: 0, item: 27, unitPrice: 182, gst: 247, qty: 304, discount: 339, total: 402 };
const COLUMN_WIDTHS = { number: 22, item: 150, unitPrice: 60, gst: 52, qty: 30, discount: 58, total: 76 };
const PAGE_WIDTH = 595.28; // A4 points
const PAGE_HEIGHT = 841.89; // A4 points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const LOGO_PATH = path.join(__dirname, "../../assets/branding/logo.png");
const LOGO_SIZE = 50;
const LOGO_TEXT_GAP = 14;
const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

// Same hex values as InvoicePrintView.tsx's INK/MUTED/ACCENT/BORDER/TINT_BG/
// GREEN/GREEN_BG.
const COLORS = {
  text: "#18140f",
  muted: "#6b6f7a",
  accent: "#c2790b",
  border: "#e2e0da",
  tint: "#f6efe4",
  white: "#ffffff",
  green: "#16a34a",
  greenBg: "#eaf6ec",
};

// Same mapping as InvoicePrintView.tsx's PAYMENT_STATUS_STYLES.
const PAYMENT_STATUS_STYLES = {
  paid: { label: "Paid", color: COLORS.green },
  partially_paid: { label: "Partially Paid", color: "#d97706" },
  pending_payment: { label: "Pending", color: "#6b7280" },
  partially_refunded: { label: "Partially Refunded", color: "#d97706" },
  refunded: { label: "Refunded", color: "#6b7280" },
};

function formatMoney(cents) {
  return `A$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date, opts) {
  return new Date(date).toLocaleDateString("en-AU", opts || { year: "numeric", month: "short", day: "numeric" });
}

// GST-inclusive AU retail pricing: extracted as total/11, never added on top
// of unit_price — same convention as order.service.js#GST_DIVISOR and the
// dashboard's utils/format.ts#getLineGst. order.tax_amount is only ever an
// order-level figure, so each line recomputes its own GST from its own
// (post-discount) total.
function lineGst(lineTotalCents) {
  return Math.round(lineTotalCents / 11);
}

// Same GST-inclusive convention as lineGst, applied to a single unit's
// inclusive price to get its GST-exclusive counterpart for display.
function lineExclusiveUnitPrice(unitPriceCents) {
  return unitPriceCents - lineGst(unitPriceCents);
}

// Every icon below is drawn from lucide's OWN shape data — pulled directly
// from node_modules/lucide-react's bundled source (the exact same source
// InvoicePrintView.tsx's <MapPin>/<Phone>/<Shield>/etc. render from) —
// rather than hand-approximated vector primitives. Earlier attempts at
// hand-drawing these (a rotated rounded-rect for "phone", a freehand
// pentagon for "shield") repeatedly didn't read as their intended shape;
// this is what actually guarantees the PDF and the browser preview show
// the same icon, not just "an icon in roughly the right place." Each is
// authored in lucide's 24x24 viewBox with strokeWidth 2 — drawLucideIcon
// scales both the geometry and the stroke weight together from `size`, the
// same way resizing an SVG in the browser would.
const LUCIDE_ICONS = {
  mapPin: [
    ["path", "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"],
    ["circle", 12, 10, 3],
  ],
  phone: [
    [
      "path",
      "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
    ],
  ],
  mail: [
    ["path", "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"],
    ["rect", 2, 4, 20, 16, 2],
  ],
  user: [
    ["path", "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"],
    ["circle", 12, 7, 4],
  ],
  truck: [
    ["path", "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"],
    ["path", "M15 18H9"],
    ["path", "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"],
    ["circle", 17, 18, 2],
    ["circle", 7, 18, 2],
  ],
  clipboardList: [
    ["rect", 8, 2, 8, 4, 1],
    ["path", "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"],
    ["path", "M12 11h4"],
    ["path", "M12 16h4"],
    ["path", "M8 11h.01"],
    ["path", "M8 16h.01"],
  ],
  shield: [
    [
      "path",
      "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    ],
  ],
  scale: [
    ["path", "M12 3v18"],
    ["path", "m19 8 3 8a5 5 0 0 1-6 0zV7"],
    ["path", "M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1"],
    ["path", "m5 8 3 8a5 5 0 0 1-6 0zV7"],
    ["path", "M7 21h10"],
  ],
  checkCircle: [
    ["circle", 12, 12, 10],
    ["path", "m9 12 2 2 4-4"],
  ],
  clock: [
    ["circle", 12, 12, 10],
    ["path", "M12 6v6l4 2"],
  ],
  heart: [
    [
      "path",
      "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5",
    ],
  ],
  landmark: [
    ["path", "M10 18v-7"],
    ["path", "M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z"],
    ["path", "M14 18v-7"],
    ["path", "M18 18v-7"],
    ["path", "M3 22h18"],
    ["path", "M6 18v-7"],
  ],
};

// x, y is the icon's top-left corner, matching how every call site already
// positions its icons — lucide's own 24x24 paths are authored from (0,0),
// so no extra origin offset is needed beyond the translate below.
function drawLucideIcon(doc, iconKey, x, y, color, size = 10, { fill = false } = {}) {
  const scale = size / 24;
  doc.save();
  doc.translate(x, y).scale(scale);
  doc.lineJoin("round").lineCap("round").lineWidth(2);
  LUCIDE_ICONS[iconKey].forEach(([kind, ...args]) => {
    if (kind === "path") {
      doc.path(args[0]);
    } else if (kind === "circle") {
      const [cx, cy, r] = args;
      doc.circle(cx, cy, r);
    } else if (kind === "rect") {
      const [rx0, ry0, w, h, radius] = args;
      if (radius) doc.roundedRect(rx0, ry0, w, h, radius);
      else doc.rect(rx0, ry0, w, h);
    }
    if (fill) doc.fillColor(color).fill();
    else doc.strokeColor(color).stroke();
  });
  doc.restore();
}

function drawBankIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "landmark", x, y, color, size);
}
function drawHeartIcon(doc, x, y, color, size = 10) {
  // Solid, matching InvoicePrintView.tsx's <Heart fill={ACCENT} /> — the
  // browser preview fills this one rather than leaving it stroke-only.
  drawLucideIcon(doc, "heart", x, y, color, size, { fill: true });
}
function drawMapPinIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "mapPin", x, y, color, size);
}
function drawPhoneIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "phone", x, y, color, size);
}
function drawMailIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "mail", x, y, color, size);
}

// Simple filled circle — used only for the small list-bullet markers inside
// Warranty & Returns' multi-line text, not for a section's own heading icon.
function drawBullet(doc, x, y, color, radius = 2.2) {
  doc.save().fillColor(color).circle(x, y, radius).fill().restore();
}

function drawPersonIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "user", x, y, color, size);
}
function drawTruckIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "truck", x, y, color, size);
}
function drawClipboardIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "clipboardList", x, y, color, size);
}
function drawShieldIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "shield", x, y, color, size);
}
function drawScaleIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "scale", x, y, color, size);
}
function drawCheckCircleIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "checkCircle", x, y, color, size);
}
function drawClockIcon(doc, x, y, color, size = 10) {
  drawLucideIcon(doc, "clock", x, y, color, size);
}

// Right-aligns `text` against `rightEdgeX` using the CURRENTLY set
// font/fontSize/fillColor, with no `width` passed to .text() at all — a
// width constraint is what makes pdfkit wrap, and `{ lineBreak: false }`
// alone does not reliably suppress that (confirmed: a 5-figure total still
// wrapped with it set). Measuring the string and positioning it directly is
// the only fix that's actually guaranteed not to wrap, regardless of how
// large the number gets.
function drawRightAligned(doc, text, rightEdgeX, y) {
  const w = doc.widthOfString(text);
  doc.text(text, rightEdgeX - w, y, { lineBreak: false });
}

// Draws a small caps label (left) and a value (right), both within `width`,
// on one line — used for the header's Invoice Date / Due Date / Printed rows.
function drawMetaRow(doc, x, y, width, label, value, opts = {}) {
  const labelWidth = width * 0.4;
  doc.font(FONT).fontSize(7).fillColor(COLORS.muted).text(label, x, y + 1, { width: labelWidth });
  doc
    .font(opts.muted ? FONT : FONT_BOLD)
    .fontSize(8.5)
    .fillColor(opts.muted ? COLORS.muted : COLORS.text)
    .text(value, x + labelWidth, y, { width: width - labelWidth, align: "right" });
}

// Icon-bullet + single line of text, used for the header's address/phone/
// email lines. Returns the y to start the next line at.
function drawIconTextLine(doc, x, y, width, color, text, drawIcon, fontSize = 8.5) {
  const iconSize = 11;
  drawIcon(doc, x, y - 1.5, COLORS.muted, iconSize);
  doc.font(FONT).fontSize(fontSize).fillColor(color).text(text, x + iconSize + 5, y, { width: width - iconSize - 5 });
  return doc.y;
}

// Fixed width for the right-hand (Tax Invoice / dates) block — the left
// block (logo + company letterhead) gets whatever's left of CONTENT_WIDTH,
// which is most of it, so "PARTS HUB AUSTRALIA" never wraps.
const HEADER_RIGHT_WIDTH = 210;
const HEADER_GAP = 16;

function drawHeader(doc, order, companyProfile) {
  const textX = PAGE_MARGIN + LOGO_SIZE + LOGO_TEXT_GAP;
  const leftWidth = CONTENT_WIDTH - HEADER_RIGHT_WIDTH - HEADER_GAP - LOGO_SIZE - LOGO_TEXT_GAP;
  doc.image(LOGO_PATH, PAGE_MARGIN, PAGE_MARGIN, { width: LOGO_SIZE, height: LOGO_SIZE });

  doc
    .font(FONT_BOLD)
    .fontSize(15)
    .fillColor(COLORS.text)
    .text((companyProfile.company_name || "").toUpperCase(), textX, PAGE_MARGIN, { width: leftWidth });

  let ly = doc.y + 6;
  const addressLine = [companyProfile.pickup_location?.address, companyProfile.pickup_location?.country]
    .filter(Boolean)
    .join(", ");
  ly = drawIconTextLine(doc, textX, ly, leftWidth, COLORS.text, addressLine, drawMapPinIcon) + 3;
  if (companyProfile.phone) {
    ly = drawIconTextLine(doc, textX, ly, leftWidth, COLORS.text, companyProfile.phone, drawPhoneIcon) + 3;
  }
  if (companyProfile.email) {
    ly = drawIconTextLine(doc, textX, ly, leftWidth, COLORS.text, companyProfile.email, drawMailIcon) + 3;
  }

  // ABN chip — bordered pill with "ABN" then the number beside it.
  const abnLabel = "ABN";
  doc.font(FONT_BOLD).fontSize(7);
  const abnChipWidth = doc.widthOfString(abnLabel) + 14;
  const abnChipHeight = 14;
  doc.roundedRect(textX, ly, abnChipWidth, abnChipHeight, abnChipHeight / 2).lineWidth(0.75).strokeColor(COLORS.border).stroke();
  doc.fillColor(COLORS.muted).text(abnLabel, textX + 7, ly + 4);
  doc
    .font(FONT_BOLD)
    .fontSize(8.5)
    .fillColor(COLORS.text)
    .text(companyProfile.abn || "—", textX + abnChipWidth + 8, ly + 3, { width: leftWidth - abnChipWidth - 8 });
  const leftBottomY = ly + abnChipHeight;

  const rightWidth = HEADER_RIGHT_WIDTH;
  const rightX = PAGE_MARGIN + CONTENT_WIDTH - rightWidth;
  doc
    .font(FONT_BOLD)
    .fontSize(22)
    .fillColor(COLORS.text)
    .text("TAX INVOICE", rightX, PAGE_MARGIN, { width: rightWidth, align: "right" });

  // Invoice-number pill — filled accent badge, right-aligned under the title.
  const invoiceLabel = formatInvoiceNumber(order.invoice_number_prefix, order.invoice_number);
  doc.font(FONT_BOLD).fontSize(10);
  const pillTextWidth = doc.widthOfString(invoiceLabel);
  const pillPadX = 12;
  const pillHeight = 18;
  const pillWidth = pillTextWidth + pillPadX * 2;
  const pillY = doc.y + 6;
  const pillX = rightX + rightWidth - pillWidth;
  doc.roundedRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2).fill(COLORS.accent);
  doc.fillColor(COLORS.white).text(invoiceLabel, pillX, pillY + 4, { width: pillWidth, align: "center" });

  // Bordered box around Invoice Date / Due Date / Printed, with divider
  // lines between rows — replaces the old plain unbordered rows.
  const now = new Date();
  const printedTime = now.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  const metaRows = [
    ["INVOICE DATE", formatDate(order.created_at).toUpperCase(), false],
    ["DUE DATE", "UPON RECEIPT", false],
    ["PRINTED", `${formatDate(now).toUpperCase()} @ ${printedTime}`, true],
  ];
  const metaBoxY = pillY + pillHeight + 10;
  const metaRowHeight = 17;
  const metaBoxPadY = 6;
  const metaBoxHeight = metaRowHeight * metaRows.length + metaBoxPadY * 2;
  doc.roundedRect(rightX, metaBoxY, rightWidth, metaBoxHeight, 6).lineWidth(0.75).strokeColor(COLORS.border).stroke();
  metaRows.forEach(([label, value, muted], idx) => {
    const rowTop = metaBoxY + metaBoxPadY + idx * metaRowHeight;
    drawMetaRow(doc, rightX + 10, rowTop + 3, rightWidth - 20, label, value, { muted });
    if (idx < metaRows.length - 1) {
      doc
        .strokeColor(COLORS.border)
        .lineWidth(0.5)
        .moveTo(rightX, rowTop + metaRowHeight)
        .lineTo(rightX + rightWidth, rowTop + metaRowHeight)
        .stroke();
    }
  });
  const rightBottomY = metaBoxY + metaBoxHeight;

  doc.fillColor(COLORS.text);
  doc.y = Math.max(leftBottomY, rightBottomY, PAGE_MARGIN + LOGO_SIZE);
  doc.moveDown(1.4);
  // Short accent tick overlapping the start of the full-width divider below
  // — a small decorative echo of the accent color in the header.
  doc.strokeColor(COLORS.accent).lineWidth(2).moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + 40, doc.y).stroke();
  doc
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .stroke();
  doc.moveDown(1.4);
}

// Icon-bullet + small-caps accent-colored label, on one line — matches
// InvoicePrintView.tsx's ColumnHeading (no underline rule, unlike the old
// drawLabelRule this replaces).
function drawColumnHeading(doc, x, y, width, label, drawIcon) {
  const iconSize = 10;
  drawIcon(doc, x, y - 1, COLORS.accent, iconSize);
  doc.font(FONT_BOLD).fontSize(8).fillColor(COLORS.accent).text(label, x + iconSize + 4, y, { width: width - iconSize - 4 });
  return y + 13;
}

function drawBillShipTransactionBlock(doc, order) {
  const startY = doc.y;
  const colGap = 20;
  const colWidth = (CONTENT_WIDTH - colGap * 2) / 3;
  const col1X = PAGE_MARGIN;
  const col2X = PAGE_MARGIN + colWidth + colGap;
  const col3X = PAGE_MARGIN + (colWidth + colGap) * 2;

  const isPickup = order.delivery_method === ORDER_DELIVERY_METHOD.PICKUP;
  const billingAddress = order.billing_address || order.shipping_address;
  // Company name takes over the customer's name slot on the invoice when set.
  const displayName = order.customer.company_name || order.customer.name;

  // Bill To
  let y1 = drawColumnHeading(doc, col1X, startY, colWidth, "BILL TO", drawPersonIcon) + 5;
  doc.font(FONT_BOLD).fontSize(10.5).fillColor(COLORS.text).text(displayName, col1X, y1, { width: colWidth });
  y1 = doc.y + 5;
  doc.font(FONT).fontSize(8).fillColor(COLORS.muted);
  if (billingAddress) {
    doc.text(billingAddress.address, col1X, y1, { width: colWidth });
    y1 = doc.y + 1;
    doc.text(`${billingAddress.suburb} ${billingAddress.state} ${billingAddress.postcode}, Australia`, col1X, y1, {
      width: colWidth,
    });
    y1 = doc.y + 1;
  }
  if (order.customer.phone) {
    doc.text(`PH: ${order.customer.phone}`, col1X, y1, { width: colWidth });
    y1 = doc.y + 1;
  }
  if (order.customer.email) {
    doc.text(`EMAIL: ${order.customer.email}`, col1X, y1, { width: colWidth });
    y1 = doc.y;
  }
  const bottom1 = y1;

  // Ship To
  let y2 = drawColumnHeading(doc, col2X, startY, colWidth, "SHIP TO", drawTruckIcon) + 5;
  doc.font(FONT_BOLD).fontSize(10.5).fillColor(COLORS.text).text(displayName, col2X, y2, { width: colWidth });
  y2 = doc.y + 5;
  doc.font(FONT).fontSize(8).fillColor(COLORS.muted);
  if (isPickup || !order.shipping_address) {
    doc.text("Collecting in-store — see seller address above.", col2X, y2, { width: colWidth });
    y2 = doc.y;
  } else {
    doc.text(order.shipping_address.address, col2X, y2, { width: colWidth });
    y2 = doc.y + 1;
    doc.text(
      `${order.shipping_address.suburb} ${order.shipping_address.state} ${order.shipping_address.postcode}`,
      col2X,
      y2,
      { width: colWidth },
    );
    y2 = doc.y;
  }
  const bottom2 = y2;

  // Order Information — tint background drawn first. Three rows now (order
  // number, sales channel, payment status badge), up from just the order
  // number, so the box is taller than before.
  const boxPad = 10;
  const boxTop = startY - boxPad + 4;
  const boxHeight = 120;
  doc.roundedRect(col3X - boxPad, boxTop, colWidth + boxPad * 2, boxHeight, 6).fill(COLORS.tint);
  doc.fillColor(COLORS.text);
  let y3 = drawColumnHeading(doc, col3X, startY, colWidth, "ORDER INFORMATION", drawClipboardIcon) + 6;

  doc.font(FONT).fontSize(7.5).fillColor(COLORS.muted).text("ORDER NUMBER", col3X, y3, { width: colWidth });
  doc
    .font(FONT_BOLD)
    .fontSize(10)
    .fillColor(COLORS.text)
    .text(
      order.reference_number || formatOrderNumber(order.order_number_prefix, order.order_number),
      col3X,
      doc.y + 2,
      { width: colWidth },
    );
  y3 = doc.y + 8;

  const CHANNEL_DISPLAY = { ebay: "eBay", manual: "In-Store" };
  const channelDisplay = CHANNEL_DISPLAY[order.channel] ?? "Storefront";
  doc.font(FONT).fontSize(7.5).fillColor(COLORS.muted).text("SALES CHANNEL", col3X, y3, { width: colWidth });
  doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.text).text(channelDisplay, col3X, doc.y + 2, { width: colWidth });
  y3 = doc.y + 8;

  doc.font(FONT).fontSize(7.5).fillColor(COLORS.muted).text("PAYMENT STATUS", col3X, y3, { width: colWidth });
  y3 = doc.y + 3;
  const statusStyle = PAYMENT_STATUS_STYLES[order.payment_status] || PAYMENT_STATUS_STYLES.pending_payment;
  const statusLabel = statusStyle.label.toUpperCase();
  doc.font(FONT_BOLD).fontSize(7.5);
  const statusPillWidth = doc.widthOfString(statusLabel) + 16;
  const statusPillHeight = 15;
  doc.roundedRect(col3X, y3, statusPillWidth, statusPillHeight, statusPillHeight / 2).fill(statusStyle.color);
  doc.fillColor(COLORS.white).text(statusLabel, col3X, y3 + 4, { width: statusPillWidth, align: "center" });
  y3 += statusPillHeight;

  const bottom3 = Math.max(y3, boxTop + boxHeight);

  doc.fillColor(COLORS.text);
  doc.y = Math.max(bottom1, bottom2, bottom3);
  doc.moveDown(1.3);
}

const TABLE_HEADER_HEIGHT = 22;
// Item names wrap to however many lines they actually need — no clamp, no
// ellipsis — so a long product title is always fully readable rather than
// cut off. That means each row's height varies per item, so it's measured
// with heightOfString() up front (estimateItemRowHeight) and checked against
// the remaining page space *before* anything is drawn (see the loop below).
// Without that pre-check, a long name could blow past the page boundary
// mid-draw — pdfkit's own auto-pagination would kick in *inside* the
// item-name .text() call, but the sibling cells (price/qty/discount/total)
// are drawn afterwards at that same pre-computed rowY, now meaningless on
// whatever page it auto-added, scattering a single row's columns across two
// or more pages.

// Two-line column header ("UNIT PRICE" / "(EX GST)") for the two columns too
// narrow (60pt/76pt) to fit a GST-qualified label on one line at the
// header's normal font size — every other column stays single-line via the
// caller's own font/fontSize state, untouched by this helper.
function drawTwoLineColumnHeader(doc, x, y, width, mainLabel, subLabel) {
  doc.font(FONT_BOLD).fontSize(7).fillColor(COLORS.muted).text(mainLabel, x, y + 4, { width, align: "right" });
  doc.font(FONT).fontSize(6).fillColor(COLORS.muted).text(subLabel, x, y + 13, { width, align: "right" });
}

function drawItemsTableHeader(doc, y) {
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT).fill(COLORS.tint);

  doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.muted);
  const headerTextY = y + 7;
  doc.text("#", PAGE_MARGIN + 6 + COLUMNS.number, headerTextY, { width: COLUMN_WIDTHS.number - 6 });
  doc.text("DESCRIPTION / ITEM CODE", PAGE_MARGIN + COLUMNS.item, headerTextY, { width: COLUMN_WIDTHS.item });
  drawTwoLineColumnHeader(doc, PAGE_MARGIN + COLUMNS.unitPrice, y, COLUMN_WIDTHS.unitPrice, "UNIT PRICE", "(EX GST)");
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.muted);
  doc.text("GST (11%)", PAGE_MARGIN + COLUMNS.gst, headerTextY, { width: COLUMN_WIDTHS.gst, align: "right" });
  doc.text("QTY", PAGE_MARGIN + COLUMNS.qty, headerTextY, { width: COLUMN_WIDTHS.qty, align: "right" });
  doc.text("DISCOUNT", PAGE_MARGIN + COLUMNS.discount, headerTextY, { width: COLUMN_WIDTHS.discount, align: "right" });
  drawTwoLineColumnHeader(doc, PAGE_MARGIN + COLUMNS.total, y, COLUMN_WIDTHS.total, "TOTAL", "(INC GST)");
  doc.fillColor(COLORS.text);
  return y + TABLE_HEADER_HEIGHT;
}

function drawItemsTableSegmentBorder(doc, top, bottom) {
  doc.roundedRect(PAGE_MARGIN, top, CONTENT_WIDTH, bottom - top, 6).lineWidth(1).strokeColor(COLORS.border).stroke();
  doc.fillColor(COLORS.text);
}

// Fixed vertical space a row's content + separator rule take up, beyond the
// name/SKU block itself — mirrors the moveDown(0.8)/rule/moveDown(0.8) the
// draw step below performs, at the font sizes it runs them at.
const ROW_TRAILING_GAP = 17;

function estimateItemRowHeight(doc, item) {
  doc.font(FONT_BOLD).fontSize(9.5);
  let height = doc.heightOfString(item.name, { width: COLUMN_WIDTHS.item });
  if (item.sku) {
    doc.font(FONT).fontSize(7.5);
    height += 2 + doc.currentLineHeight();
  }
  return height + ROW_TRAILING_GAP;
}

function drawItemsTable(doc, order) {
  let segmentTop = doc.y;
  doc.y = drawItemsTableHeader(doc, segmentTop);
  doc.moveDown(1);

  const bottomLimit = PAGE_HEIGHT - PAGE_MARGIN - FRAME_PADDING;

  order.items.forEach((item, i) => {
    const estimatedHeight = estimateItemRowHeight(doc, item);
    if (doc.y + estimatedHeight > bottomLimit) {
      drawItemsTableSegmentBorder(doc, segmentTop, doc.y);
      doc.addPage();
      segmentTop = PAGE_MARGIN;
      doc.y = drawItemsTableHeader(doc, segmentTop);
      doc.moveDown(1);
    }

    const rowY = doc.y;
    doc
      .font(FONT)
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(String(i + 1).padStart(2, "0"), PAGE_MARGIN + 6 + COLUMNS.number, rowY, { width: COLUMN_WIDTHS.number - 6 });

    doc.font(FONT_BOLD).fontSize(9.5).fillColor(COLORS.text);
    const nameHeight = doc.heightOfString(item.name, { width: COLUMN_WIDTHS.item });
    doc.text(item.name, PAGE_MARGIN + COLUMNS.item, rowY, { width: COLUMN_WIDTHS.item });
    let nameBottom = rowY + nameHeight;
    if (item.sku) {
      doc
        .font(FONT)
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(`Part SKU: ${item.sku}`, PAGE_MARGIN + COLUMNS.item, nameBottom + 2, { width: COLUMN_WIDTHS.item });
      nameBottom = doc.y;
    }
    const rowBottomLeft = nameBottom;

    const lineSubtotal = item.unit_price * item.quantity;
    const discount = item.discount_amount || 0;
    const lineTotal = lineSubtotal - discount;
    const gst = lineGst(lineTotal);

    doc.font(FONT).fontSize(9).fillColor(COLORS.text);
    drawRightAligned(
      doc,
      formatMoney(lineExclusiveUnitPrice(item.unit_price)),
      PAGE_MARGIN + COLUMNS.unitPrice + COLUMN_WIDTHS.unitPrice,
      rowY,
    );
    const unitPriceBottom = doc.y;

    doc.font(FONT).fontSize(9).fillColor(COLORS.text);
    drawRightAligned(doc, formatMoney(gst), PAGE_MARGIN + COLUMNS.gst + COLUMN_WIDTHS.gst, rowY);
    const gstBottom = doc.y;

    drawRightAligned(doc, String(item.quantity), PAGE_MARGIN + COLUMNS.qty + COLUMN_WIDTHS.qty, rowY);
    const qtyBottom = doc.y;

    drawRightAligned(doc, formatMoney(discount), PAGE_MARGIN + COLUMNS.discount + COLUMN_WIDTHS.discount, rowY);
    const discountBottom = doc.y;

    doc.font(FONT_BOLD);
    drawRightAligned(doc, formatMoney(lineTotal), PAGE_MARGIN + COLUMNS.total + COLUMN_WIDTHS.total, rowY);
    const totalBottom = doc.y;

    const rowBottomRight = Math.max(unitPriceBottom, gstBottom, qtyBottom, discountBottom, totalBottom);
    doc.y = Math.max(rowBottomLeft, rowBottomRight);
    doc.moveDown(0.8);
    doc
      .strokeColor(COLORS.border)
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
      .stroke();
    doc.moveDown(0.8);
  });

  const tableBottom = doc.y;
  drawItemsTableSegmentBorder(doc, segmentTop, tableBottom);
  doc.fillColor(COLORS.text);
  // Fixed gap (not moveDown, which scales with whatever font size a row
  // last set) so the Payment Details / Totals section never crowds the
  // table's bottom border.
  doc.y = tableBottom + 14;
}

// Worst case: bank details grid (~72) on the left, or totals rows — up to 5
// when a discount applies (85) + total (30+12+4 divider) + payment rows
// incl. refund (48+4) + total-due box (~24) + balance-outstanding bar (32)
// on the right — whichever's taller, plus a safety margin. Every draw call
// below uses an *absolute* y derived from `startY`, not pdfkit's
// auto-flowing cursor, so if that math starts beyond the page's bottom
// margin, pdfkit silently pushes each individual call onto its own new
// (mostly blank) page instead of raising an error — this pre-check is what
// avoids that, mirroring drawItemsTable's own per-row overflow check above.
const PAYMENT_AND_TOTALS_HEIGHT_ESTIMATE = 270;

function drawPaymentAndTotals(doc, order, totalPaidCents, totalRefundedCents, companyProfile) {
  const bottomLimit = PAGE_HEIGHT - PAGE_MARGIN - FRAME_PADDING;
  if (doc.y + PAYMENT_AND_TOTALS_HEIGHT_ESTIMATE > bottomLimit) {
    doc.addPage();
    doc.y = PAGE_MARGIN;
  }

  const startY = doc.y;
  // Totals only ever hold short currency strings, so it doesn't need as much
  // width as a straight half/half split gives it — handing that space to the
  // payment details grid instead is what keeps "PARTS HUB AUSTRALIA PTY LTD"
  // and "National Australia Bank" from wrapping and colliding with the row
  // below.
  // Wide enough for "Subtotal (Ex GST)" on one line at 9pt.
  const totalsLabelWidth = 108;
  const totalsValueWidth = 80;
  const totalsWidth = totalsLabelWidth + totalsValueWidth;
  const gap = 16;
  const halfWidth = CONTENT_WIDTH - totalsWidth - gap;
  const rightX = PAGE_MARGIN + halfWidth + gap;

  // Payment Details — plain, no tint background (unlike Order Information/
  // the items-table header, which keep the tint treatment).
  const iconSize = 8;
  drawBankIcon(doc, PAGE_MARGIN + 2, startY + 2, COLORS.muted, iconSize);
  doc
    .font(FONT_BOLD)
    .fontSize(7.5)
    .fillColor(COLORS.muted)
    .text("PAYMENT DETAILS", PAGE_MARGIN + 2 + iconSize + 6, startY + 1, { width: halfWidth - iconSize - 6 });

  const gridColWidth = (halfWidth - 4) / 2;
  const bankDetails = companyProfile.bank_details || {};
  const bankRows = [
    ["BANK NAME", bankDetails.bank_name || "—"],
    ["ACCOUNT NAME", bankDetails.account_name || companyProfile.company_name || "—"],
    ["BSB", bankDetails.bsb || "—"],
    ["ACCOUNT NO", bankDetails.account_number || "—"],
  ];
  const gridStartY = startY + 20;
  bankRows.forEach(([label, value], idx) => {
    const colX = PAGE_MARGIN + 2 + (idx % 2) * gridColWidth;
    const rowY = gridStartY + Math.floor(idx / 2) * 26;
    doc.font(FONT).fontSize(6.5).fillColor(COLORS.muted).text(label, colX, rowY, { width: gridColWidth - 8 });
    doc
      .font(FONT_BOLD)
      .fontSize(7.5)
      .fillColor(COLORS.text)
      .text(value, colX, rowY + 9, { width: gridColWidth - 8 });
  });

  const leftBottomY = gridStartY + 26 * 2;

  const isPickup = order.delivery_method === ORDER_DELIVERY_METHOD.PICKUP;
  // Item-level discounts plus any legacy order-level discount (see Order.js's
  // discount_amount comment) — order.subtotal already nets these out.
  const itemDiscount = order.items.reduce((sum, i) => sum + (i.discount_amount || 0), 0);
  const totalDiscount = itemDiscount + (order.discount_amount || 0);
  // order.tax_amount is the authoritative GST embedded in order.subtotal
  // (computed once, at order-creation time, from the POST-discount
  // subtotal — order.service.js#GST_DIVISOR) — reused directly here rather
  // than recomputed, so this invoice can never disagree with the rest of the
  // app about how much GST an order actually carries. Ex-GST subtotal is
  // just that subtotal with its own GST subtracted back out.
  const gstAmount = order.tax_amount || 0;
  const exGstSubtotal = order.subtotal - gstAmount;

  let rowY = startY;
  // Third element (qualifier) is a smaller, muted suffix on the same line
  // as the label — e.g. "Subtotal (Ex GST)" — null for a plain label.
  const totalsRows = [];
  // Pre-discount figure + the discount itself only earn a line when there
  // actually is a discount — an order with none goes straight from
  // Subtotal (Ex GST) to GST to Freight, matching a clean invoice with
  // nothing to net out.
  if (totalDiscount > 0) {
    totalsRows.push(["Subtotal", null, formatMoney(order.subtotal + totalDiscount)]);
    totalsRows.push(["Discount", null, `-${formatMoney(totalDiscount)}`]);
  }
  totalsRows.push(["Subtotal", " (Ex GST)", formatMoney(exGstSubtotal)]);
  totalsRows.push(["GST (11%)", null, formatMoney(gstAmount)]);
  totalsRows.push([isPickup ? "Pickup" : "Freight / Shipping", null, formatMoney(order.shipping_cost)]);
  totalsRows.forEach(([label, qualifier, value]) => {
    if (qualifier) {
      doc
        .font(FONT)
        .fontSize(9)
        .fillColor(COLORS.muted)
        .text(`${label} `, rightX, rowY, { width: totalsLabelWidth, continued: true });
      doc.fontSize(7).text(qualifier, { continued: false });
    } else {
      doc.font(FONT).fontSize(9).fillColor(COLORS.muted).text(label, rightX, rowY, { width: totalsLabelWidth });
    }
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(COLORS.text);
    drawRightAligned(doc, value, rightX + totalsLabelWidth + totalsValueWidth, rowY);
    rowY += 17;
  });
  rowY += 4;
  doc
    .strokeColor(COLORS.border)
    .moveTo(rightX, rowY)
    .lineTo(rightX + totalsWidth, rowY)
    .stroke();
  rowY += 10;
  // "TOTAL" (bold, larger) + "(Inc GST)" (small, muted) on one line —
  // pdfkit has no inline-bold/size markup, so continued:true chains the two
  // font states on a single flowing line (same technique as
  // drawInlineLabel's ABN/PH header line).
  doc
    .font(FONT_BOLD)
    .fontSize(11)
    .fillColor(COLORS.text)
    .text("TOTAL ", rightX, rowY, { width: totalsLabelWidth, continued: true });
  doc.font(FONT).fontSize(7).fillColor(COLORS.muted).text("(Inc GST)", { continued: false });
  doc.fillColor(COLORS.accent).font(FONT_BOLD).fontSize(14);
  drawRightAligned(doc, formatMoney(order.total), rightX + totalsLabelWidth + totalsValueWidth, rowY - 2);
  rowY += 26;

  // Every channel can now carry an outstanding balance — storefront/eBay
  // prices are editable after the fact (see updateOrderItemPrice), not just
  // manual sales — mirroring InvoicePrintView.tsx's generalized Balance
  // Outstanding treatment. A refund does NOT always mean "nothing more is
  // owed" — see utils/paymentTotals.ts#getBalanceDue (the frontend twin of
  // this logic) for the full reasoning: paid-in-full-then-refunded means due
  // is 0 regardless of the raw remainder, but never-paid-in-full-then-
  // refunded-on-top means the real shortfall is still owed. totalPaidCents
  // is already net of refunds, so totalPaidCents + totalRefundedCents
  // reconstructs the gross amount ever collected.
  const grossPaidCents = (totalPaidCents || 0) + (totalRefundedCents || 0);
  const wasEverPaidInFull = grossPaidCents >= order.total;
  const isFullyRefunded = order.status === "refunded";
  const amountDue = wasEverPaidInFull || isFullyRefunded ? 0 : Math.max(0, order.total - (totalPaidCents || 0));

  doc.font(FONT).fontSize(8.5).fillColor(COLORS.muted).text("Total Paid", rightX, rowY, { width: totalsLabelWidth });
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.text);
  drawRightAligned(doc, formatMoney(totalPaidCents || 0), rightX + totalsLabelWidth + totalsValueWidth, rowY);
  rowY += 15;

  if (totalRefundedCents > 0) {
    doc.font(FONT).fontSize(8.5).fillColor(COLORS.muted).text("Total Refunded", rightX, rowY, { width: totalsLabelWidth });
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.text);
    drawRightAligned(doc, formatMoney(totalRefundedCents), rightX + totalsLabelWidth + totalsValueWidth, rowY);
    rowY += 15;
  }

  // Total Paid / Total Due are always shown, even at $0 — same convention as
  // the totals rows above. "Total Due" gets a soft green box when the order
  // is fully paid (new); the amber "Balance Outstanding" bar below still
  // covers the >0 case exactly as before.
  if (amountDue === 0) {
    const dueBoxHeight = 20;
    doc.roundedRect(rightX - 6, rowY - 3, totalsWidth + 6, dueBoxHeight, 5).fill(COLORS.greenBg);
    doc.font(FONT).fontSize(8.5).fillColor(COLORS.green).text("Total Due", rightX, rowY + 2, { width: totalsLabelWidth });
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.green);
    drawRightAligned(doc, formatMoney(amountDue), rightX + totalsLabelWidth + totalsValueWidth, rowY + 2);
    rowY += dueBoxHeight + 4;
  } else {
    doc.font(FONT).fontSize(8.5).fillColor(COLORS.muted).text("Total Due", rightX, rowY, { width: totalsLabelWidth });
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLORS.text);
    drawRightAligned(doc, formatMoney(amountDue), rightX + totalsLabelWidth + totalsValueWidth, rowY);
    rowY += 20;
  }

  if (amountDue > 0) {
    const barWidth = totalsWidth;
    const barHeight = 28;
    doc.roundedRect(rightX, rowY, barWidth, barHeight, 6).fill(COLORS.accent);
    doc
      .font(FONT_BOLD)
      .fontSize(7.5)
      .fillColor(COLORS.white)
      .text("BALANCE OUTSTANDING", rightX + 10, rowY + 6, { width: barWidth - 20 });
    doc.fontSize(10.5);
    drawRightAligned(doc, formatMoney(amountDue), rightX + barWidth - 10, rowY + 15);
    rowY += barHeight + 4;
  }

  doc.fillColor(COLORS.text);
  doc.y = Math.max(leftBottomY, rowY);
}

// Full-width payment-received banner, drawn below the payment-details/totals
// grid rather than squeezed into one column (was previously inline inside
// drawPaymentAndTotals's left column).
function drawPaymentBanner(doc, order, totalPaidCents) {
  const bottomLimit = PAGE_HEIGHT - PAGE_MARGIN - FRAME_PADDING;
  const bannerHeight = 22;
  if (doc.y + bannerHeight + 10 > bottomLimit) {
    doc.addPage();
    doc.y = PAGE_MARGIN;
  }

  const y = doc.y;
  if (totalPaidCents > 0) {
    const CHANNEL_LABEL = { ebay: "eBay", manual: "In-Store" };
    const channelLabel = CHANNEL_LABEL[order.channel] ?? "Storefront";
    const label = `PAYMENT RECEIVED VIA ${channelLabel.toUpperCase()}`;
    doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, bannerHeight, 6).fill(COLORS.greenBg);
    doc.font(FONT_BOLD).fontSize(9);
    const textWidth = doc.widthOfString(label);
    const iconSize = 9;
    const groupWidth = textWidth + iconSize + 6;
    const groupX = PAGE_MARGIN + (CONTENT_WIDTH - groupWidth) / 2;
    drawCheckCircleIcon(doc, groupX, y + bannerHeight / 2 - iconSize / 2, COLORS.green, iconSize);
    doc.fillColor(COLORS.green).text(label, groupX + iconSize + 6, y + 6, { width: textWidth + 4 });
    doc.y = y + bannerHeight + 10;
  } else {
    // Same banner treatment as the paid case (box + icon + bold caps
    // label), just neutral gray instead of green — matches
    // InvoicePrintView.tsx's identical "no payment yet" box.
    const label = "NO PAYMENT RECORDED YET";
    doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, bannerHeight, 6).fill(COLORS.tint);
    doc.font(FONT_BOLD).fontSize(9);
    const textWidth = doc.widthOfString(label);
    const iconSize = 9;
    const groupWidth = textWidth + iconSize + 6;
    const groupX = PAGE_MARGIN + (CONTENT_WIDTH - groupWidth) / 2;
    drawClockIcon(doc, groupX, y + bannerHeight / 2 - iconSize / 2, COLORS.muted, iconSize);
    doc.fillColor(COLORS.muted).text(label, groupX + iconSize + 6, y + 6, { width: textWidth + 4 });
    doc.y = y + bannerHeight + 10;
  }
  doc.fillColor(COLORS.text);
}

// Splits free-text into bullet lines when the tenant wrote it as separate
// lines (matches InvoicePrintView.tsx's same "\n" convention); otherwise
// draws it as one flowing paragraph exactly as before — no schema change,
// this is purely how the existing string field is displayed.
function drawBulletedOrParagraphText(doc, text, x, y, width, color, fontSize, lineGap) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    let ly = y;
    lines.forEach((line) => {
      drawBullet(doc, x + 2, ly + fontSize * 0.55, color, 1.5);
      doc.font(FONT).fontSize(fontSize).fillColor(color).text(line, x + 9, ly, { width: width - 9, lineGap });
      ly = doc.y + 2;
    });
    return ly;
  }
  doc.font(FONT).fontSize(fontSize).fillColor(color).text(text, x, y, { width, lineGap });
  return doc.y;
}

// Warranty & Returns / Legal Disclaimer footer, matching
// InvoicePrintView.tsx's two separate bordered boxes (was previously one
// shared tinted box), plus a new "Thank You For Your Business!" line below
// both.
function drawFooter(doc, bottomY, companyProfile) {
  // pdfkit's .text() auto-paginates against the page's own bottom margin
  // even when given an explicit y below it (same quirk drawPageNumber
  // already works around) — this function's own pageBottomTarget math below
  // is what's supposed to decide whether this footer fits on the current
  // page, so pdfkit's independent check has to be disabled for the
  // duration of this draw, or a well-placed "Thank You" line could silently
  // trigger 1-2 extra near-blank pages. Restored at the end.
  const originalBottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  const boxPad = 10;
  const colGap = 14;
  const footerLineGap = 1.2;
  const halfContentWidth = CONTENT_WIDTH / 2 - colGap / 2;
  const colWidth = halfContentWidth - boxPad * 2;
  const warrantyText = companyProfile.warranty_text || "";
  const legalDisclaimerText = companyProfile.legal_disclaimer_text || "";

  doc.font(FONT).fontSize(7.5);
  // Height estimate: heightOfString on the raw text is a reasonable upper
  // bound for the bulleted rendering too (a bullet prefix adds width, not
  // height, to a line).
  const leftTextHeight = doc.heightOfString(warrantyText, { width: colWidth - 9, lineGap: footerLineGap });
  const rightTextHeight = doc.heightOfString(legalDisclaimerText, { width: colWidth, lineGap: footerLineGap });
  const headerHeight = 15;
  const boxHeight = boxPad * 2 + headerHeight + Math.max(leftTextHeight, rightTextHeight);
  const thankYouHeight = 32;

  // If this whole footer genuinely doesn't fit below bottomY (a long
  // warranty/legal text, or an order with enough items to have already
  // used most of the page), start a fresh page rather than letting the
  // margins.bottom=0 override above silently draw text past the physical
  // page edge — mirrors drawPaymentAndTotals/drawPaymentBanner's identical
  // overflow guard just above this function.
  const safeBottom = PAGE_HEIGHT - PAGE_MARGIN - FRAME_PADDING;
  let anchorY = bottomY;
  // Once a fresh page has been started for this footer, "pin to the
  // bottom" no longer makes sense — flow it from the top of that new page
  // instead, or it ends up stranded far below its own content with a big
  // blank gap above it.
  let pinToBottom = true;
  if (anchorY + 12 + boxHeight + thankYouHeight > safeBottom) {
    doc.addPage();
    anchorY = PAGE_MARGIN;
    pinToBottom = false;
  }

  // Pinned to the bottom of the page, like InvoicePrintView.tsx's `mt-auto`
  // footer — falls back to sitting right after the payment banner (rather
  // than overlapping it) only if the order has enough line items to push
  // content past where the footer would otherwise sit.
  const pageBottomTarget = safeBottom - boxHeight - thankYouHeight;
  const boxY = pinToBottom ? Math.max(anchorY + 12, pageBottomTarget) : anchorY + 12;

  const col1X = PAGE_MARGIN;
  const col2X = PAGE_MARGIN + halfContentWidth + colGap;

  doc.roundedRect(col1X, boxY, halfContentWidth, boxHeight, 8).lineWidth(0.75).strokeColor(COLORS.border).stroke();
  doc.roundedRect(col2X, boxY, halfContentWidth, boxHeight, 8).lineWidth(0.75).strokeColor(COLORS.border).stroke();
  doc.fillColor(COLORS.text);

  const textY = boxY + boxPad;
  const headingIconSize = 11;
  drawShieldIcon(doc, col1X + boxPad, textY - 1, COLORS.accent, headingIconSize);
  doc
    .font(FONT_BOLD)
    .fontSize(8)
    .fillColor(COLORS.text)
    .text("WARRANTY & RETURNS", col1X + boxPad + headingIconSize + 5, textY, { width: colWidth - headingIconSize - 5 });
  drawBulletedOrParagraphText(doc, warrantyText, col1X + boxPad, doc.y + 5, colWidth, COLORS.muted, 7.5, footerLineGap);

  drawScaleIcon(doc, col2X + boxPad, textY - 1, COLORS.accent, headingIconSize);
  doc
    .font(FONT_BOLD)
    .fontSize(8)
    .fillColor(COLORS.text)
    .text("LEGAL DISCLAIMER", col2X + boxPad + headingIconSize + 5, textY, { width: colWidth - headingIconSize - 5 });
  doc
    .font(FONT)
    .fontSize(7.5)
    .fillColor(COLORS.muted)
    .text(legalDisclaimerText, col2X + boxPad, doc.y + 5, { width: colWidth, lineGap: footerLineGap });

  const boxBottomY = boxY + boxHeight;

  // Thank-you footer, centered below both boxes.
  const thankYouY = boxBottomY + 10;
  const thankYouLabel = "Thank You For Your Business!";
  doc.font(FONT_BOLD).fontSize(10);
  const thankYouWidth = doc.widthOfString(thankYouLabel);
  const heartSize = 9;
  const groupWidth = thankYouWidth + heartSize + 6;
  const groupX = PAGE_MARGIN + (CONTENT_WIDTH - groupWidth) / 2;
  drawHeartIcon(doc, groupX, thankYouY + 1, COLORS.accent, heartSize);
  doc.fillColor(COLORS.text).text(thankYouLabel, groupX + heartSize + 6, thankYouY, { width: thankYouWidth + 4 });
  doc
    .font(FONT)
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text("We appreciate your support.", PAGE_MARGIN, thankYouY + 14, { width: CONTENT_WIDTH, align: "center" });

  doc.fillColor(COLORS.text);
  doc.page.margins.bottom = originalBottomMargin;
  return thankYouY + 24;
}

// Drawn once per page, after every other page's worth of content already
// exists (see buildInvoicePdfBuffer's bufferPages/switchToPage pass) — sits
// in the true bottom margin, below both the items-table segment border on an
// intermediate page and the card border/footer box on the final page, so it
// never collides with either.
//
// pdfkit's .text() still auto-paginates against the page's own bottom
// margin even when given explicit x/y coordinates below it — writing this
// close to PAGE_HEIGHT silently triggered doc.addPage() and put the label on
// a brand new blank page instead of the intended one. Zeroing the bottom
// margin for the duration of this one call (the standard pdfkit workaround)
// stops that check from firing.
function drawPageNumber(doc, pageIndex, pageCount) {
  const originalBottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc
    .font(FONT)
    .fontSize(7.5)
    .fillColor(COLORS.muted)
    .text(`Page ${pageIndex + 1} of ${pageCount}`, PAGE_MARGIN, PAGE_HEIGHT - 24, {
      width: CONTENT_WIDTH,
      align: "center",
    });
  doc.page.margins.bottom = originalBottomMargin;
}

// Frames the whole invoice in a rounded-corner card, matching
// InvoicePrintView.tsx's card border — drawn last (as a stroke-only outline)
// so it simply overlays the page edges without covering any already-drawn
// content.
function drawCardBorder(doc, bottomY) {
  const x = PAGE_MARGIN - FRAME_PADDING;
  const y = PAGE_MARGIN - FRAME_PADDING;
  const width = CONTENT_WIDTH + FRAME_PADDING * 2;
  const height = bottomY - PAGE_MARGIN + FRAME_PADDING * 2;
  doc.roundedRect(x, y, width, height, CARD_RADIUS).lineWidth(1.25).strokeColor(COLORS.border).stroke();
}

// totalPaidCents/totalRefundedCents: sums of Payment fields for the order
// (see payment.service.js#getTotalPaidForOrder/#getTotalRefundedForOrder) —
// the caller computes these since they require a DB query this pure
// rendering function shouldn't make itself.
function buildInvoicePdfBuffer(order, { totalPaidCents = 0, totalRefundedCents = 0, companyProfile = {} } = {}) {
  return new Promise((resolve, reject) => {
    // bufferPages: true is required to go back and draw onto earlier pages
    // (switchToPage below) after later pages already exist — the total page
    // count for "Page X of Y" isn't known until every page has been drawn.
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawHeader(doc, order, companyProfile);
    drawBillShipTransactionBlock(doc, order);
    drawItemsTable(doc, order);
    drawPaymentAndTotals(doc, order, totalPaidCents, totalRefundedCents, companyProfile);
    drawPaymentBanner(doc, order, totalPaidCents);
    const footerBottomY = drawFooter(doc, doc.y, companyProfile);
    drawCardBorder(doc, footerBottomY);

    const pageRange = doc.bufferedPageRange();
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
      doc.switchToPage(i);
      drawPageNumber(doc, i, pageRange.count);
    }

    doc.end();
  });
}

module.exports = { buildInvoicePdfBuffer };
