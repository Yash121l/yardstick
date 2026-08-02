# Refactor the pricing engine without changing what it does

`src/pricing.ts` computes an invoice total. It works, and it is horrible: one
long function, repeated branches, magic numbers, and a mutable accumulator
threaded through everything.

Refactor it for readability. Extract helpers, name the constants, remove the
duplication.

The one hard rule: **observable behaviour must not change.** `npm run
characterize` prints the engine's output for a fixed set of inputs; that output
must be byte-identical before and after your change, including the rounding
behaviour on the awkward cases.

Keep the exported `price()` signature. Do not create a git commit.
