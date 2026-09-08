const { enqueueEmailJob } = require("../../queues/email.queue");
const config = require("../../config");

const defaultFrom = () =>
  `"${config.emailBrand.fromName}" <${config.emailBrand.fromEmail}>`;

// Customer-facing order emails (shipped/pickup/confirmation/receipt) must
// look like they came from the tenant's own business, not the platform.
// Only the display NAME can be pre-built here — the actual address depends
// on which SMTP account ends up sending it (the tenant's own, if they've
// configured one, otherwise the platform's), which mailer.js resolves at
// send time (see mailer.js#sendEmail's fromName/tenantId handling).
const tenantFromName = (companyProfile) => companyProfile?.company_name || null;

const tenantBrandVars = (companyProfile) => ({
  app_name: companyProfile?.company_name || config.emailBrand.appName,
  support_email: companyProfile?.email || config.emailBrand.supportEmail,
});

/**
 * Send OTP for Login Verification
 */
async function sendOTP({ to, name, otp }) {
  return enqueueEmailJob({
    from: defaultFrom(),
    to,
    subject: `Login Verification Code - ${config.emailBrand.appName}`,
    template: "otpVerification",
    variables: {
      name,
      otp,
    },
  });
}

/**
 * Send Account Verification Notification
 */
async function accountVerified({ to, name, verifiedDate }) {
  return enqueueEmailJob({
    from: defaultFrom(),
    to,
    subject: `Account Verified - ${config.emailBrand.appName}`,
    template: "accountVerified", // Make sure this matches the .hbs filename exactly
    variables: {
      name,
      verified_date: verifiedDate,
      login_url: `${config.emailBrand.clientUrl}/login`,
    },
  });
}

/**
 * Send Password Reset Email
 */
async function sendPasswordReset({ to, name, resetUrl, expiryMinutes }) {
  return enqueueEmailJob({
    from: defaultFrom(),
    to,
    subject: `Password Reset Request - ${config.emailBrand.appName}`,
    template: "passwordReset",
    variables: {
      name,
      reset_url: resetUrl,
      expiry_minutes: expiryMinutes,
    },
  });
}

/**
 * Notify a tenant's own inbox of a storefront inquiry submitted by one of
 * their customers — `to` is that tenant's own email (resolved by the
 * caller, e.g. inquiry.controller.js via getCompanyProfile), never a
 * platform-wide address, since a different tenant's inquiry must never land
 * in another tenant's (or the platform's own) inbox.
 */
async function sendInquiryNotification({ to, customerName, customerEmail, customerPhone, subject, message }) {
  return enqueueEmailJob({
    from: defaultFrom(),
    to,
    subject: `[Inquiry] ${subject} — ${customerName}`,
    template: "inquiryNotification",
    variables: {
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone || null,
      subject,
      message,
      app_name: config.emailBrand.appName,
    },
  });
}

/**
 * Notify a tenant's own inbox of a new storefront newsletter subscriber —
 * same reasoning as sendInquiryNotification: `to` is that tenant's own email.
 */
async function sendNewsletterSignupNotification({ to, subscriberEmail }) {
  return enqueueEmailJob({
    from: defaultFrom(),
    to,
    subject: `[Newsletter] New subscriber — ${subscriberEmail}`,
    template: "newsletterNotification",
    variables: {
      subscriber_email: subscriberEmail,
    },
  });
}

/**
 * Notify a customer that their DELIVERY order has shipped, with tracking
 * details and the tax invoice attached as a PDF (base64-encoded — Bull job
 * payloads are JSON over Redis, so a raw Buffer wouldn't round-trip to the
 * worker intact).
 */
async function sendOrderShipped({ to, name, orderNumber, trackingNumber, carrierName, pdfBase64, pdfFilename, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: "Your Order Has Been Shipped",
    template: "orderShipped",
    variables: {
      name,
      order_number: orderNumber,
      tracking_number: trackingNumber,
      carrier_name: carrierName,
      ...tenantBrandVars(companyProfile),
    },
    attachments: [
      {
        filename: pdfFilename,
        content: pdfBase64,
        encoding: "base64",
      },
    ],
  });
}

/**
 * Notify a customer that their PICKUP order is ready for collection, with
 * the tax invoice attached as a PDF (base64-encoded — Bull job payloads are
 * JSON over Redis, so a raw Buffer wouldn't round-trip to the worker intact).
 */
async function sendOrderReadyForPickup({ to, name, orderNumber, pdfBase64, pdfFilename, pickupLocation = {}, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: "Your Order Is Ready for Pickup",
    template: "orderReadyForPickup",
    variables: {
      name,
      order_number: orderNumber,
      pickup_location_name: pickupLocation.name || "",
      pickup_address: pickupLocation.address || "",
      pickup_country: pickupLocation.country || "",
      trading_hours: pickupLocation.trading_hours || [],
      ...tenantBrandVars(companyProfile),
    },
    attachments: [
      {
        filename: pdfFilename,
        content: pdfBase64,
        encoding: "base64",
      },
    ],
  });
}

/**
 * Notify a customer their DELIVERY storefront order was placed and paid —
 * sent automatically once payment succeeds for delivery_method = delivery
 * (see stripe.webhook.service.js). No invoice attached here; that's sent
 * manually later via the admin's "Send Email" action (sendOrderShipped above).
 */
async function sendOrderConfirmation({ to, name, orderNumber, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: "Order Confirmation",
    template: "orderConfirmation",
    variables: {
      name,
      order_number: orderNumber,
      ...tenantBrandVars(companyProfile),
    },
  });
}

/**
 * Notify a customer their PICKUP storefront order was placed and paid — sent
 * automatically once payment succeeds for delivery_method = pickup (see
 * stripe.webhook.service.js). No invoice attached here; that's sent manually
 * later via the admin's "Send Email" action (sendOrderReadyForPickup above).
 */
async function sendOrderReceivedPickup({ to, name, orderNumber, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: "Your Order Has Been Received",
    template: "orderReceivedPickup",
    variables: {
      name,
      order_number: orderNumber,
      ...tenantBrandVars(companyProfile),
    },
  });
}

/**
 * Send the tax invoice/receipt for an in-person/manual sale created from the
 * admin dashboard — no shipped/pickup framing (the sale is already
 * complete), just the invoice and, if the customer still owes money, the
 * outstanding balance called out up front.
 */
async function sendManualOrderReceipt({ to, name, orderNumber, amountDue, pdfBase64, pdfFilename, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: `Your Invoice — Order ${orderNumber}`,
    template: "manualOrderReceipt",
    variables: {
      name,
      order_number: orderNumber,
      amount_due: amountDue || null,
      ...tenantBrandVars(companyProfile),
    },
    attachments: [
      {
        filename: pdfFilename,
        content: pdfBase64,
        encoding: "base64",
      },
    ],
  });
}

/**
 * Send a customer a link to pay an order online (manual/in-store sale where
 * staff chose "Payment Link (Stripe)" as the settlement method) — triggered
 * by the "Send Payment Link" action on the order creation confirmation
 * screen. No invoice PDF attached; the customer sees the invoice once they
 * pay, same as any other guest checkout.
 */
async function sendPaymentLink({ to, name, orderNumber, amountDue, paymentUrl, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: `Complete Your Payment — Order ${orderNumber}`,
    template: "paymentLink",
    variables: {
      name,
      order_number: orderNumber,
      amount_due: amountDue || null,
      payment_url: paymentUrl,
      ...tenantBrandVars(companyProfile),
    },
  });
}

/**
 * Send a product's title/SKU/images to a recipient the admin picks —
 * triggered by the "Send Email" action on the product edit page. Images are
 * attached by disk path (not base64) since the email worker shares the same
 * uploads volume as the API — see product.service.js#sendProductInfoEmail.
 */
async function sendProductInfo({ to, name, productTitle, productSku, attachments = [], companyProfile, tenantId }) {
  return enqueueEmailJob(
    {
      fromName: tenantFromName(companyProfile),
      tenantId,
      to,
      subject: `Product Info — ${productTitle}`,
      template: "productInfo",
      variables: {
        name,
        product_title: productTitle,
        product_sku: productSku || null,
        has_images: attachments.length > 0,
        ...tenantBrandVars(companyProfile),
      },
      attachments,
    },
    // Product photos can be several MB each and are sent through a
    // deliberately rate-limited SMTP transporter (see config.smtp) — the
    // queue's default 30s job timeout is fine for a lightweight OTP/PDF
    // email but too short here, and since a Bull job timeout can't actually
    // cancel an in-flight SMTP send, a spurious timeout used to trigger up
    // to 5 retries that each *also* completed the real send afterward,
    // duplicate-delivering the same email to the recipient several times.
    // A longer ceiling makes hitting it rare; fewer attempts caps the
    // worst-case duplicate count if it's ever hit anyway.
    { timeout: 180000, attempts: 2 },
  );
}

/**
 * Send a tenant's daily low-stock digest — triggered by the
 * low_stock_digest_sweep repeatable job, see
 * services/inventory-digest.service.js. Always called with at least one
 * item; the sweep never calls this for an empty digest (see that service's
 * own comment on why — an empty "0 items low" email is just noise).
 */
async function sendLowStockDigest({ to, items, companyProfile, tenantId }) {
  return enqueueEmailJob({
    fromName: tenantFromName(companyProfile),
    tenantId,
    to,
    subject: `Low Stock Alert — ${items.length} item${items.length === 1 ? "" : "s"} need attention`,
    template: "lowStockDigest",
    variables: {
      items: items.map((i) => ({
        title: i.variant_name ? `${i.title} — ${i.variant_name}` : i.title,
        sku: i.sku || "—",
        stock: i.stock,
      })),
      item_count: items.length,
      ...tenantBrandVars(companyProfile),
    },
  });
}

module.exports = {
  sendOTP,
  accountVerified,
  sendPasswordReset,
  sendInquiryNotification,
  sendNewsletterSignupNotification,
  sendOrderShipped,
  sendOrderReadyForPickup,
  sendOrderConfirmation,
  sendOrderReceivedPickup,
  sendManualOrderReceipt,
  sendPaymentLink,
  sendProductInfo,
  sendLowStockDigest,
};
