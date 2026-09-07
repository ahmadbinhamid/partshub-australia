// services/ebay/ebay.environment-invariants.test.js
//
// Static guard against the exact class of bug this whole hardening pass
// exists to close: a function that receives a TENANT's own (environment-
// specific) `settings` building its eBay base URL from a hardcoded-
// production source (a literal *BaseFor(false)/*BaseUrlFor(false) call, or
// a module-level constant built from one) instead of from
// settings.sandbox. See ebay.catalog.service.js#metadataBaseFor's own
// comment for the incident this exact pattern caused (condition-policy
// lookups silently failing for every sandbox-connected tenant, only
// surfacing much later as eBay error 25021 at publishOffer).
//
// This reads the SOURCE TEXT of the two files directly (no AST parser —
// this repo has no npm dependencies to add) rather than importing and
// exercising them, so it catches the mistake in ANY function matching the
// pattern, even one no other test happens to exercise yet — this is the
// test that would have caught the original bug.
//
// Run with: node --test src/services/ebay/ebay.environment-invariants.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FILES = [
  path.join(__dirname, "ebay.catalog.service.js"),
  path.join(__dirname, "ebay.api.service.js"),
];

// Functions that receive `settings` but are DELIBERATELY exempt: they use
// (or feed) an app-level client_credentials token that is ALWAYS
// production — see getCatalogToken's own comment — because eBay's SANDBOX
// taxonomy tree does not work at all, not because settings.sandbox was
// forgotten. Any name added here must carry that same kind of
// justification (a genuinely fixed-environment token paired with a
// genuinely fixed-environment host), not just "inconvenient to fix right
// now".
const ALLOWLIST = new Set([
  "getCategorySuggestions", // early-returns a sandbox sentinel before ever building the production URL for real data — see its own "Sandbox caveat" comment
  "getCategoryTreeId",
  "getDefaultCategoryTreeId",
  "getItemAspectsForCategory",
  "getCatalogToken",
]);

// A hardcoded-production base-URL helper call, generalized over this
// codebase's *BaseFor(sandbox)/*BaseUrlFor(sandbox) naming convention
// (apiBaseUrlFor, taxonomyBaseUrlFor, inventoryBaseFor, fulfillmentBaseFor,
// metadataBaseFor, ...) — literally passing `false` is the smoking gun,
// regardless of which specific helper it is.
const HARDCODED_PRODUCTION_CALL_RE = /\b[A-Za-z]*[Bb]ase(?:Url)?For\(\s*false\s*\)/;

// Extracts { name, params, body } for every top-level `function`/`async
// function` declaration in `source`, by brace-counting from the opening
// `{` — this codebase declares every function this way (verified: no arrow-
// function-assigned exports in either file), and brace-counting is far more
// reliable for capturing a whole function body than a bounded regex would be.
function extractFunctions(source) {
  const fns = [];
  const declRe = /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*{/g;
  let match;
  while ((match = declRe.exec(source))) {
    const [full, name, params] = match;
    const bodyStart = match.index + full.length;
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    fns.push({ name, params, body: source.slice(bodyStart, i - 1), bodyStart, bodyEnd: i - 1 });
  }
  return fns;
}

// Blanks out every extracted function's body (preserving offsets, though
// nothing here depends on that) so a LOCAL `const res = ...`/`const url =
// ...` inside some unrelated function can never be mistaken for a real
// module-level constant — this was a real false positive caught while
// writing this test: `const res = await fetch(...)`, declared inside the
// allowlisted getDefaultCategoryTreeId/getItemAspectsForCategory (which do
// legitimately hardcode production), was being picked up as a
// "module-level constant named res" and then flagged in every OTHER
// function that also happens to name its fetch response `res` — which is
// most of them.
function stripFunctionBodies(source, functions) {
  let result = source;
  for (const fn of functions) {
    result = result.slice(0, fn.bodyStart) + " ".repeat(fn.bodyEnd - fn.bodyStart) + result.slice(fn.bodyEnd);
  }
  return result;
}

// Module-level `const X = ...<hardcoded-production call>...;` names — a
// function body referencing one of these by name is exactly as
// hardcoded-production as writing the call inline (this is literally how
// the original bug read: `const METADATA_BASE = \`${apiBaseUrlFor(false)}...\`;`
// used inside getConditionPolicies, which takes `settings`). Only ever run
// against the STRIPPED (function-bodies-blanked) source — see
// stripFunctionBodies above.
function findHardcodedProductionConstants(strippedSource) {
  const names = [];
  const constRe = /const\s+(\w+)\s*=\s*[^;]*;/g;
  let match;
  while ((match = constRe.exec(strippedSource))) {
    if (HARDCODED_PRODUCTION_CALL_RE.test(match[0])) names.push(match[1]);
  }
  return names;
}

for (const file of FILES) {
  const basename = path.basename(file);

  test(`${basename}: no tenant-settings function hardcodes a production base URL`, () => {
    const source = fs.readFileSync(file, "utf8");
    const functions = extractFunctions(source);
    const hardcodedConstants = findHardcodedProductionConstants(stripFunctionBodies(source, functions));

    const offenders = [];
    for (const fn of functions) {
      if (ALLOWLIST.has(fn.name)) continue;

      // "receives tenant-scoped settings": this codebase's own convention
      // is a plain `settings` positional parameter on every function that
      // makes a per-tenant eBay API call — see getAccessToken,
      // getConditionPolicies, upsertInventoryItem, createOffer, etc.
      const takesSettings = new RegExp(String.raw`(^|,)\s*settings\b`).test(fn.params);
      if (!takesSettings) continue;

      const usesLiteralProductionCall = HARDCODED_PRODUCTION_CALL_RE.test(fn.body);
      const usesHardcodedConstant = hardcodedConstants.some((c) => new RegExp(String.raw`\b${c}\b`).test(fn.body));

      if (usesLiteralProductionCall || usesHardcodedConstant) {
        offenders.push(fn.name);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "\n\nRULE: a function that receives a tenant's own (environment-specific) `settings` must build its " +
        "eBay base URL from settings.sandbox (e.g. apiBaseUrlFor(settings.sandbox), or a per-call helper " +
        "like metadataBaseFor(settings.sandbox)) — never from a literal *BaseFor(false)/*BaseUrlFor(false) " +
        "call or a module-level constant built from one. Sending a tenant's own token to the wrong " +
        "environment's host is rejected outright by eBay, and the failure gets swallowed and only surfaces " +
        "much later, far from its real cause (see ebay.catalog.service.js#metadataBaseFor's own comment " +
        "for the exact incident this rule exists to prevent).\n" +
        "If this is a genuine, deliberate exception (an app-level token that's ALSO always production, e.g. " +
        "the taxonomy tree — see getCatalogToken's own comment), add the function's name to ALLOWLIST above " +
        "with the same justification, not just to make this test pass.\n\n" +
        `Offending function(s) in ${basename}: ${offenders.join(", ") || "(none — see assertion diff)"}`,
    );
  });
}
