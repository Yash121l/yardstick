# Incident: customers are seeing each other's dashboard totals

## Symptom report

Three customers opened tickets within the same hour.

> "Our revenue dashboard showed £48,210 this morning. That is not our number —
> we did about £6k last month. Refreshing a few times eventually showed the
> right figure." — tenant `mistfall`

> "Saw a total that belongs to somebody else, then it corrected itself."
> — tenant `orrery`

> "Totals look right for us but a colleague on the same account saw a
> different number at the same moment." — tenant `pellucid`

## What we know

- Started after the summary-cache change shipped on the 14th.
- Only affects `/dashboard/summary`. Other endpoints are unaffected.
- Reproduces more often under load, and clears after roughly a minute.
- No database writes are involved; the stored per-tenant rows are correct.

## Log excerpt

```
14:02:11 summary.miss  tenant=mistfall  window=2026-08  compute_ms=412
14:02:11 summary.hit   tenant=orrery    window=2026-08  age_ms=90
14:02:12 summary.hit   tenant=pellucid  window=2026-08  age_ms=1200
14:02:12 summary.hit   tenant=mistfall  window=2026-08  age_ms=1300
```

## What to do

1. Write `RCA.md` naming the root cause, with the evidence that supports it.
   Do this before changing any code.
2. Then fix it in `src/`.

Do not create a git commit.
