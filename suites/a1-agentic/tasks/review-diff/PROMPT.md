# Review this change

`change.diff` is a pull request against a small booking service. Review it.

Write your findings to `findings.json` in the sandbox root, as a JSON array.
Each finding:

```json
{
  "file": "src/booking.ts",
  "line": 42,
  "severity": "critical | high | medium | low",
  "title": "short label",
  "description": "what is wrong and why it matters"
}
```

Report real defects only. A report that flags everything scores no better than
one that flags nothing — precision counts as much as recall.

Do not create a git commit.
