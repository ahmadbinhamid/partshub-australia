// src/queues/ebay.queue.js
//
// Backward-compatible shim over queues/channel.queue.js's "ebay" queue.
// Kept so anything that still imports this module directly (ebay.listing.
// controller.js, older deploys' in-flight code, this repo's own pre-
// existing tests that mock enqueueEbayJob directly) keeps working exactly
// as before — see channel.queue.js's module header for why the underlying
// Bull queue name itself was never allowed to change.
//
// `ebayQueue` used to call channel.queue.js's own getQueue("ebay") EAGERLY,
// right here at module load — defeating getQueue's own lazy-per-platform
// caching the moment anything merely required this file (several
// pre-existing tests do, directly, per the module header above). Found
// live: that's a real `new Queue("ebay", ...)` / real ioredis connection,
// opened just by require()ing this shim, exactly the same class of bug
// queues/email.queue.js's own comment describes in full (and traced the
// same way — process._getActiveHandles() showing a lingering Redis Socket
// after everything else had disconnected) — services/refund.service.ledger-violation.test.js
// requires this module directly and was hanging the full suite because of
// it. Now a getter, so `ebayQueue` is only ever actually constructed (via
// getQueue's own cache, so still exactly one instance either way) the first
// time something really accesses the property — for every real caller
// (ebay.listing.controller.js, ebay.worker.js, etc.) that's the exact same
// moment as before, since they destructure it immediately after requiring
// this module.
//
// enqueueEbayJob calls channel.queue.js's enqueueChannelJobDirect (the real
// implementation), NOT enqueueChannelJob (the override-checking public
// entry point) — this module registers ITSELF as the "ebay" override below,
// so calling the public one from here would recurse straight back into this
// function.

const { getQueue, enqueueChannelJobDirect, registerEnqueueOverride } = require("./channel.queue");

async function enqueueEbayJob(type, payload, opts = {}) {
  return enqueueChannelJobDirect("ebay", type, payload, opts);
}

module.exports = {
  get ebayQueue() {
    return getQueue("ebay");
  },
  enqueueEbayJob,
};

// Registered last (module.exports already assigned above) so the override
// always dispatches through the CURRENT value of module.exports.enqueueEbayJob
// — including a test's mock.method() patch applied after this module was
// first required, which replaces that property in place.
registerEnqueueOverride("ebay", (jobName, payload, opts) => module.exports.enqueueEbayJob(jobName, payload, opts));
