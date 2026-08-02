# Assumptions — webhook retry

"Add retries" leaves five things open. I have chosen an answer for each and
implemented against it. Each is a decision you can overrule cheaply; none of
them should be discovered by reading the diff.

## Open questions and the answer I took

1. **How many attempts?** Not stated. Assuming a maximum of 4 total attempts
   (1 initial plus 3 retries). Rationale: covers the overwhelming majority of
   transient blips without holding a worker for minutes.

2. **What delay between attempts?** Not stated. Assuming exponential backoff
   starting at 100ms and doubling, with full jitter. Rationale: a fixed
   interval synchronises every failing endpoint into the same retry wave.
   Delay is injected so tests do not have to wait.

3. **Which failures are retried?** Not stated. Assuming 5xx, 429 and transport
   timeouts are retried; other 4xx are terminal. Rationale: a 400 is a
   malformed payload and will fail identically forever, so retrying it only
   multiplies load.

4. **Is delivery idempotent?** Not stated, and this is the one worth pushing
   back on. Retrying means at-least-once delivery, so a customer whose endpoint
   succeeded but whose response we lost will see a duplicate. Assuming the event
   id is sufficient for the receiver to deduplicate, and sending it as an
   `Idempotency-Key`-style field. If receivers cannot dedupe, this needs a
   different design and not just a retry loop.

5. **What happens after the final failure?** Not stated. Assuming we return
   `delivered: false` with the attempt count and let the caller decide. Not
   silently dropping. A dead-letter queue is the natural next step but is out
   of scope for this change.

## What I would ask before shipping

- Do customer endpoints deduplicate on event id today, or is that aspirational?
- Is there an existing per-customer rate limit that the retry wave could trip?
- Should the attempt budget be per event or per endpoint per window?
