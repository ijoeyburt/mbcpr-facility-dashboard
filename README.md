# MBCPR Facility Dashboard

Push-to-talk broadcast, local shuffle/loop music playlists, checklist/chem/incident/referral
forms with next-due logic, and email alerts on incident/referral submission.

Deploys the same way as the original walkie-broadcast project (Render + GitHub). LED-strip
integration is not included yet — everything else from the planning conversation is.

## Pages

- **`/admin.html`** — your full dashboard. Push-to-talk, music, all task lists, edit the daily notice.
- **`/guard.html`** — lifeguard link. Same push-to-talk/music/tasks, no notice-editing control.
  Share a separate URL/access code with lifeguards so it stays distinct from your admin link.
- **`/receiver.html`** — open this on the PC that's wired to the amp and leave it open all day.
  It's the only page that actually makes sound.

## One-time setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `ADMIN_ACCESS_CODE` / `GUARD_ACCESS_CODE` — two different shared codes. Each page prompts
     for its code once and remembers it in the browser (same pattern as the original app).
   - SMTP settings for incident/referral email alerts (Resend and SendGrid both have free tiers
     that are more than enough for this volume).
3. `npm start` (or deploy to Render with build command `npm install`, start command `npm start`,
   and the same env vars set in the Render dashboard — see the original project's deploy notes).

## Music folders on the receiver PC

On the PC running `/receiver.html`, put your MP3s in a folder structure like:

```
music/
  summer-mix/
    track1.mp3
    track2.mp3
  lifeguard-picks/
  chill-afternoon/
  throwbacks/
```

The subfolder names must match the `id` values in `playlists.json` (`summer-mix`,
`lifeguard-picks`, `chill-afternoon`, `throwbacks`) — rename folders or edit `playlists.json`
to match. On `/receiver.html`, click **Select music folder** and pick the parent `music/`
folder once; the browser remembers file handles for the session. Playback reads straight off
the PC's disk, so it isn't affected by weak facility Wi-Fi — only the small "play this
playlist" trigger crosses the network.

Use Chrome or Edge on the receiver PC — the folder-picker API (File System Access API) isn't
supported in Safari or Firefox.

## Editing the checklists

All task/checklist definitions (opening, closing, bathroom/deck, maintenance, chem check,
incident report, referral) live in `tasks.json` as plain data — add, remove, or reword fields
there without touching any other code. `intervalHours` / `intervalMinutes` controls how often
a task shows as due again after being submitted; `recurring: false` (used for incident and
referral) means it's always available rather than due on a timer.

## Notes / open items from the design conversation

- **Zone for push-to-talk mic is fixed to "Both."** The Pool/Pool House buttons were removed
  from the main screen per your request and zone control now only lives inside the Music
  popup. If you want per-announcement zone control later, it's a small addition — happy to
  wire it in.
- **LED strip alerts for overdue tasks are not built yet** — this build covers everything else
  from the plan. The task API already exposes `overdue: true/false` per task, so a WLED
  integration later just needs to poll `/api/tasks` and call the WLED HTTP API when something
  flips overdue.
- **Referral access**: both the admin and guard links can currently submit referrals, since
  there's no separate "lead guard" role yet. If you want referrals restricted to specific
  lifeguards, that needs a proper per-user login instead of the two shared codes — worth
  doing if the guard link ever gets shared beyond people who should have that access.
- Data (task history, notices, incident/referral records) is stored in `data/db.json` on the
  server. That's fine at this scale, but it means a Render redeploy wipes it unless you attach
  a persistent disk (Render supports this) or move to a real database later.
