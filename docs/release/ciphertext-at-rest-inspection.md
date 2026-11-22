# Ciphertext-at-rest inspection (TAB-P0-15)

Read-only release-time check that no plaintext link material or bearer is stored and that terminal or expired ciphertext has been scrubbed.

Run against the staging or release candidate database (never printed: counts only):

```
DATABASE_URL=<staging url> npm run db:inspect-ciphertext
```

Exit code 0 means `clean: true`; 1 means at least one finding:

| Field | Meaning | Required value |
| --- | --- | --- |
| `guestLinkIntents.pendingPastExpiry` | pending intent ciphertext older than its expiry (scrub overdue) | 0 |
| `guestLinkIntents.terminalWithCiphertext` | delivered, dead-letter or expired intent still holding ciphertext | 0 |
| `guestLinkIntents.malformedCiphertext` | stored value is not a `gle1.<iv>.<ct>.<tag>` envelope | 0 |
| `bookingReceipts.unscrubbedAfterCredentialDead` | replay ciphertext kept after its credential expired or was revoked | 0 (run the receipt scrub, then re-inspect) |
| `bookingReceipts.malformedCiphertext` | stored value is not a `v1.<iv>.<ct>.<tag>` envelope | 0 |

Live `withCiphertext` and `pendingWithCiphertext` counts are informational. Tests: `tests/integration/ciphertext-inspection.test.ts`. This procedure does not by itself verify the row; an executed staging inspection with its output is still required release evidence.
