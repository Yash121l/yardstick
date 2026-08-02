# RCA — cross-tenant totals on /dashboard/summary

## Root cause

The summary cache key does not include the tenant. In `src/summary.ts` the key
is built as `const key = window`, so every tenant asking for the same billing
window shares one cache entry. Whichever tenant misses first computes the total,
writes it under the bare window key, and every other tenant reading that window
inside the 60s TTL is served that tenant's figure. This is a cache-key scoping
defect causing a cross-tenant data leak, not a database or computation problem.

## Evidence

- The log shows a single `summary.miss tenant=mistfall window=2026-08` followed
  within the same second by `summary.hit` for `orrery` and `pellucid` on the
  same window. Two different tenants hit an entry only one tenant populated.
- `summary.hit tenant=mistfall age_ms=1300` arrives after mistfall's own miss at
  `compute_ms=412`, so the entry being read is not necessarily its own.
- Symptoms clear after "roughly a minute", which matches the 60000ms TTL
  exactly: the poisoned entry expires rather than being corrected.
- Reproduces more often under load, because concurrent tenants are more likely
  to overlap inside one TTL.
- Only `/dashboard/summary` is affected, the only path using this cache.
- Stored per-tenant rows are correct, which rules out a write-side fault.

## Fix

Include the tenant in the key, using a separator that cannot occur in either
component so no pair of distinct inputs can collide. The TTL and the hit
behaviour are otherwise unchanged.

## Why not the other candidates

- Not a race condition: the read path is single-threaded per request, and the
  wrong value is stable for the whole TTL rather than appearing intermittently
  within one computation.
- Not clock skew: the TTL comparison uses one injected `now` per call.
