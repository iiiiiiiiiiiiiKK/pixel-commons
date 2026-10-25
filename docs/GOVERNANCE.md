# Community governance

Pixel Commons is a shared artwork. These rules exist so a crowd can paint together without one person ruining
it for everyone.

## 1. The mechanics, restated

- **One canvas.** Everyone edits the same 256×256 board.
- **One pixel per 30 seconds, per session.** Enforced by the server. Extra tabs, private windows and
  reconnects do not grant extra turns.
- **Pixels are permanent** until an admin resets the canvas or undoes a specific write.
- **No accounts.** You get a signed anonymous session lasting 30 days. Your public label is a derived nickname
  such as `velvet-pika-744`, not your identity.

## 2. What is not allowed

1. **Hate and harassment** — slurs, targeted abuse, symbols of hate.
2. **Sexual content**, especially anything involving minors.
3. **Advertising and spam** — URLs, brand pushes, QR codes, repeated logos.
4. **Automation that bypasses the cooldown** — scripts, headless browsers, session farms.
5. **Destroying others' work at scale** — deliberate mass-overwrites of a finished area.
6. **Personal data** — doxxing, real names, phone numbers, addresses.

## 3. How moderation works

```
report ──► queue (open) ──► admin review ──► resolved | rejected
                                    │
                                    └── reset region / undo / canvas reset
```

- Anyone can report a pixel: **shift-click** it on desktop, **long-press** it on touch, or use the `report`
  button in the top-right overlay.
- Reports carry the coordinate, a reason, an optional note and the reporter's derived handle. They never appear
  in the public activity feed.
- Reports are rate limited to **10 per hour per session** so the queue stays readable.
- Admins can *resolve* (action taken) or *reject* (no action needed). Both are recorded.
- **Every admin action is appended to an audit trail** visible in the admin console: notices, clears, undos,
  report resolutions and canvas resets, with timestamps.

## 4. Admin powers and their limits

| Power | Effect | Safeguard |
| --- | --- | --- |
| Publish notice | Banner for everyone (`info` / `warn` / `maintenance`) | Logged; `maintenance` blocks all writes |
| Clear notice | Removes the banner | Logged |
| Undo last pixel | Reverts the newest history row to its previous colour | Logged, one pixel at a time |
| Rename canvas | Changes the displayed name | Logged |
| Resolve / reject report | Closes a queue item | Logged |
| Reset canvas | Deletes cells, history and snapshots; keeps the audit trail | Logged, and the UI requires typing `RESET` |

Admins **cannot** rewrite history quietly: an undo removes the latest row and restores the previous colour,
which is itself visible in the feed and the audit log. There is no "edit someone else's pixel silently" path.

## 5. Appeals

If a decision looks wrong:

1. Open a GitHub issue with the coordinate and roughly when it happened.
2. Include the snapshot link if you have one (History dialog → snapshot → *view*).
3. A maintainer will re-check the audit trail and the history rows.

## 6. Resets and data retention

- The canvas is reset only for genuine emergencies (coordinated attack, illegal content) or a scheduled
  community "fresh start" announced in advance via a notice.
- History is trimmed to the newest 2 000 rows; older activity survives inside snapshots taken every 10 minutes
  of drawing activity (max 96 snapshots).
- Resetting the canvas also deletes snapshots. The audit trail is preserved on purpose, so resets remain
  accountable.

## 7. Events and themes

Theme days are announced through the admin notice banner. They are invitations, not rules — nobody is required
to follow a theme, and nobody may erase work that ignores it.

## 8. Etiquette that makes the canvas better

- Leave room. If a region is clearly someone's project, don't fill it with noise.
- Small, deliberate sprites read better than large flat fills.
- Use the palette; a limited palette is what makes the board look like one artwork instead of 200 screenshots.
- Zoom out (`fit`) before you start. Most bad decisions are made at 20×.
