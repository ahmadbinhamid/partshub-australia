# Project conventions

This is a monorepo: the frontend lives at the repo root (`src/`), the backend
lives in `server/` (Node/Express/Mongoose). Follow these conventions on
**every** change in this repo, not just when reminded.

## Frontend (`src/`)

- **Reuse existing components before writing raw HTML.** Check
  `src/components/ui/` (buttons, cards, badges, menus, breadcrumbs, etc.)
  and the relevant feature folder under `src/components/` (`products/`,
  `orders/`, `media/`, `customers/`, `inventory/`, `payments/`, `pos/`,
  `refunds/`, `domains/`, `ebay-settings/`, `tenant-settings/`, `shared/`,
  `shell/`, `layouts/`, `theme/`, `activity/`, `auth/`, `branding/`,
  `categories/`, `dashboard/`, `providers/`, ...) for an existing component
  that already does the job. Don't reinvent a button/card/badge/dialog that
  already exists.
- **Use the app's own design tokens, not arbitrary Tailwind values.** Colors
  are CSS vars defined in `src/app/globals.css` (`bg`, `fg`, `card`,
  `accent`, `border`, `danger`, `warn`, `ok`, etc.); typography is the scale
  defined in that file's `@layer base` block. Don't hardcode a hex color or
  an arbitrary Tailwind color class when a token already covers it.
  - Exception (established precedent, fine to keep following): full-bleed
    dark overlays — modal scrims, image lightboxes, "Cover" badges on
    thumbnails — use literal `bg-black/*` + `text-white` throughout the
    codebase (see `Modal.tsx`, `Dialog.tsx`, `Sheet.tsx`,
    `ProductImages.tsx`), since theme tokens would be invisible against a
    black scrim.
- **A new component gets its own file**, placed in the relevant feature
  folder under `src/components/` (e.g. `src/components/media/`,
  `src/components/products/`) — matching how existing components like
  `ProductImages.tsx` / `ProductStockCard.tsx` are organized. Don't inline a
  new component into a page file.
- **Where types/constants go:**
  - Domain/API model interfaces (Product, Order, Attachment, Customer,
    Domain, Listing, ...) go in `src/types/*.ts`.
  - A component's own local `Props` interface, and small constants used
    only by that component, stay inline in the component's file — don't
    split those out to `src/types/` just because they're an interface.
  - Shared cross-page constants (option lists, enums used by multiple
    features) go in `src/config/*`.
- Follow general industry-standard React/TypeScript structure and
  architecture otherwise — keep the project's existing folder shape and
  naming conventions rather than introducing a new pattern for one feature.

## Backend (`server/src/`)

- **DB access lives in a service, never directly in a controller/route/worker.**
  Follow the existing layering: `routes/*.routes.js` → `controllers/*.controller.js`
  (thin — validates input, calls a service, shapes the response) →
  `services/*.service.js` (owns all Mongoose model access) → `models/*.js`.
  A queue worker (`workers/*.js`) follows the same rule: it calls a service
  function, it never queries a model directly (see
  `services/marketplace/sync.service.js#getListingPushSeq` /
  `refresh.service.js`, both called from `workers/channel.worker.js` rather
  than querying `MarketplaceListing`/`ChannelConnection` inline).
- **Don't collapse the controller/route/service/model layers** for the sake
  of a "quick" feature — a background job, a webhook handler, and a cron-style
  sweep all still put their DB logic in a service file (see
  `services/marketplace/refresh.service.js` as the reference for a
  non-HTTP-triggered feature: no controller/route needed since nothing calls
  it over HTTP, but the DB logic still lives in its own service file, never
  inline in the worker).
- **Extract helper functions** where they reduce duplication or clarify a
  multi-step operation, rather than writing one long function
  (e.g. `sync.service.js`'s `processBatchChunk` factored out of `syncBatch`).
- **Reuse existing checks/utilities instead of reimplementing them** — e.g.
  the circuit-breaker gate (`circuitBreaker.isOpen`), the "not connected"
  determination (`adapter.loadSettings` resolving to `null`), the fencing-
  token pattern, error `.status` conventions for
  `circuitBreaker.js#isTransportOrAuthFailure`. Grep for an existing
  service-layer function before writing a new query that does the same
  thing.
- Keep code optimized and idiomatic: cursor-based iteration for
  unbounded/large collections, batched (not per-item) queries where
  possible, chunked processing for bulk jobs — matching how
  `sync.service.js#syncBatch` and `refresh.service.js#sweepStaleListings`
  are written.

## Before finishing any change

- **FE**: reusable component used (not raw HTML)? theme tokens used (not
  arbitrary colors)? new component is its own file in the right feature
  folder? types/constants placed per the rule above?
- **BE**: DB access is in a service (not the controller/route/worker)?
  controller/route/model separation respected? helpers extracted where
  useful? existing checks/utilities reused instead of duplicated?
