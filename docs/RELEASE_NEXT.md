# Next release (company deployment)

The running release manifest: everything on `origin/master` that the company deployment
(far.nephroplus.com, Docker on NephroPlus's own server with its own Postgres) does not
have yet. It is updated with every change pushed to `origin`, and it becomes the single
DevOps handover when the release is signed off.

| | |
|---|---|
| Company is currently on | `9f32dfa` (frozen; no pushes until the release is signed off) |
| This release | everything after `9f32dfa` on `origin/master` (a fast-forward from `9f32dfa`) |
| Proposed tag | `v1.2`, created only once the deploy is confirmed |
| Status | in UAT on personal Vercel |

## At a glance for DevOps

- **Env vars:** no new or changed variables. `.env` stays as it is.
- **Database:** additive only (new tables and columns, three widened CHECK constraints,
  and a one-time conversion of approval rules into workflows + assignments). Applied
  automatically, once, on the first boot of the new image. No manual SQL.
- **First boot:** the one-time schema update takes seconds. It clears the cached report
  figures once, and the built-in pre-warm then rebuilds them (allow up to ~15 minutes).
- **Behaviour after deploy:** unchanged until an admin configures an approval workflow
  (the approval system is off by default). Edit Asset is now logged in the Activity Log.
- **Deploy:** `git pull` + `docker compose up -d --build` (a rebuild, not a restart).

---

## Changes

### 1. Approval workflows (maker-checker)
Commits: `3a97d83` (server), `c9b0945`, `1156b42` (client), `1cd6a50`, `c29308f`,
`a2f36b0`, `5e4a9c2`, `9dcc966`

**What changed**
- Admin-configurable approval workflows per module: Capitalization, Additions,
  Disposals, Transfers, Edit Asset, the four Bulk Upload types, and Masters.
  - Ordered steps with no cap.
  - Approvers are users and/or roles, with an "any one" or "all must approve" rule per step.
  - Rules are chosen by the submitter's role, with an optional amount threshold.
  - Screen: Approval Workflows (admins).
- Submitted entries wait in their own tables and are written to the register only on
  final approval, through the same route and validation as a direct entry. The calc
  engine is untouched.
- Controls:
  - separation of duties: nobody approves their own request, or more than one step of it;
  - center scoping;
  - admin reassignment (logged);
  - an aging flag after N days.
- Rejection needs a comment; the submitter edits and resubmits the same request, which
  restarts at step 1 with its history kept.
- Bulk files are approved or rejected as a whole:
  - totals by center, plus a searchable before/after preview;
  - applied in the background in resumable, idempotent slices;
  - every row is re-checked first, and if any row fails nothing is applied.
- New Tasks screen for every user (Awaiting my approval / My requests / All requests),
  with a sidebar badge and server-side notifications in the bell.
- Activity Log:
  - Edit Asset is now always logged, with before/after values (new "Asset Edit" category);
  - entries applied through an approval list every approver: step, who, when and comment.
- Masters duplicates are refused at submission, against existing entries and other
  pending requests.
- UI:
  - Open Sans body font app-wide;
  - 150–200 ms motion that honours reduced-motion;
  - "Submit for approval" button text when a workflow applies.
- Fixes found during UAT:
  - The self-nudge that keeps a bulk apply moving used the wrong scheme behind Vercel,
    and arrived unauthenticated (`5e4a9c2`). This also affected background exports, which
    only moved on the browser's polls.
  - A stalled bulk apply is resumed by any signed-in user's badge poll (`1cd6a50`).

**Database (automatic on first boot, `server/src/db/approvalsSchema.sql`)**
- New tables:
  - `approval_workflows`;
  - `approval_config` (one row, aging days default 3);
  - `change_requests`, `change_request_actions`, `change_request_chunks`, `change_request_rows`;
  - `notifications`;
  - plus their indexes.
- `asset_activity_log`: the action CHECK is widened to allow `asset_edit`, and a new
  nullable column `approval_request_id`.
- `master_activity_log`: a new nullable column `approval_request_id`.
- A one-time permission grant: `approvals:manageWorkflows`, `approvals:viewAll` and
  `approvals:reassign` go to every role and user that already has
  `admin:managePermissions`. It only runs if no approvals grants exist yet.
- The schema fingerprint changes, so the first boot clears `report_totals_cache` once and
  the pre-warm rebuilds it.
- No seed data. Existing records count as approved. No workflows are configured, so every
  module applies directly exactly as before.

**Env vars:** none new. Internal apply calls are signed with the existing `JWT_SECRET`.

**DevOps must do / expect**
- Nothing to configure. Admins set up workflows in the app when Finance is ready.
- If `JWT_SECRET` changes while a request is mid-apply, that request's internal apply
  call is refused and it shows "Needs attention" (the submitter resubmits it).

**Verified**
- Server tests (approval suite: state machine, any/all, separation of duties, initiator
  matching, snapshot, concurrency, needs-attention, reassignment, bulk apply with
  failure and resume, Masters, Edit Asset logging, approver links in the Activity Log,
  Masters duplicates at submission, a stalled job resumed by the badge poll) and client
  tests. All passing.
- UAT on personal Vercel:
  - a real three-person chain on Capitalization (editor → Finance Manager → admin);
  - rejection and resubmission;
  - two 20-row bulk files. After the self-nudge fix, the file applied 1.6 s after
    approval with no panel open (43 s before the fix). Confirmed in the Vercel logs.
- Docker (local): see change 2.

### 2. Docker fixes for the approval release
Commit: `7658889`

**What changed**
- The server build copies every `server/src/db/*.sql` into the image. Before this, the
  image had no `approvalsSchema.sql`, and **the Docker container crashed on boot**. Vercel
  bundles the SQL files differently, so UAT there didn't show it.
- On a long-running server (Docker), the bulk-apply self-nudge calls the app directly on
  `http://127.0.0.1:$PORT`. It no longer goes out through the public hostname and reverse
  proxy (no hairpin routing or TLS dependency inside the company network). Vercel keeps
  the public URL.

**Database:** none. **Env vars:** none (uses the existing `PORT`, already `3000` in `.env`).

**DevOps must do / expect:** nothing. The container must listen on the `PORT` in its own
`.env`, which it already does.

**Verified** (Docker, locally, with `docker compose --profile local-db`)
- Upgrade boot from a `d6c585b` database with 219,329 assets to this code: 1.15 s. The
  approval tables were created and there was no crash.
- A 20-row bulk file went submit → approve → applied in 605 ms. The container log shows
  the self-nudge arriving on `127.0.0.1:3000`.
- Server tests: 1050/1050.

### 3. Pre-warm workflow runs only where enabled
Commit: `b08eb52`. The same change is already on company as `9f32dfa`; merged into origin
so the release stays a fast-forward.

**What changed:** the GitHub Actions `dashboard-prewarm` job runs only if the repository
variable `PREWARM_ENABLED` is `true`. Docker pre-warms with its own built-in timer and
doesn't need it.

**Database / env vars:** none. The repository variable is set on the personal repo only.

**DevOps must do / expect:** nothing. In the company repo the workflow shows "skipped".

**Verified:** a dispatch on company showed "skipped" (2026-09-26); personal runs normally.

### 4. Docker boot check in CI
Commit: `32bc106`

**What changed**
- A new GitHub Actions workflow, `docker-boot.yml`, runs on every push (and on demand).
- It builds the image with the production Dockerfile and boots it against a throwaway
  `postgres:16-alpine`.
- It fails unless the app logs "Server listening" and `/api/health` answers, on the first
  boot (schema setup) and again after a restart (setup skipped).

**Database / env vars:** none. It needs no secrets (disposable database, `JWT_SECRET`
generated per run).

**DevOps must do / expect:** once this reaches the company repo, it runs there on each
push too. It's harmless and uses no secrets, but it does use GitHub Actions minutes.
Disable it in that repo's Actions settings if that's unwanted.

**Verified** (2026-09-26)
- Passing run on `32bc106` (run 36261623504): image built in 53 s, and both boots were
  listening and healthy in about 4 s.
- Negative check: a throwaway branch with the SQL-copy fix reverted **failed** as it
  should (run 36261751993), with "Container 'app' stopped during boot 1" and
  `ENOENT … approvalsSchema.sql`. The branch was deleted afterwards.

### 5. Approval screens: UX polish from UAT
Commits: `a5bc553`, `97f9dcf`, `8618ef0`, `5d657c3`

**What changed**
- A request sent back to the submitter now reads **"Returned"** everywhere it's shown:
  the status badge (still Crimson Red) and the Tasks status filter. The history already
  said "Returned for changes", and the notification already says "Returned for changes: …".
  The stored status value is unchanged (`rejected`), so no data migration is needed.
- The Tasks empty state is tab-specific when no filters are set:
  - Awaiting my approval: "Nothing waiting for your approval."
  - My requests: "You haven't submitted any requests yet."
  - All requests: "No approval requests yet."
  - "No requests match. Try clearing the filters." appears only when a filter is active.
- The request detail panel uses the module forms' own field labels (for example
  "Component 1 Opening Cost", "Date of Addition", "Destination Center"), in form order.
  - It hides fields that don't apply or are empty, such as a capitalization's unused
    Mid-Year Additions, zero opening accumulated depreciation, or an empty serial number.
  - For an update, it shows only the submitted fields.
  - The same labels are used in the bulk preview headers and the resubmit form.
  - Values: dates as DD-MM-YYYY. Amounts in ₹ are **never rounded**: at least 2 decimals,
    more only if the value has them (for example ₹22,632.56), in the detail table, the
    bulk preview and the bulk totals.
  - Note: the Register and other screens still show whole rupees (the app-wide
    `formatCurrency`). Only the approval panel shows paise.
- Edit Asset request titles use the form labels ("Edit CI0724: Opening Accumulated
  Depreciation (Component 1)"), not field names. This only applies to new requests;
  titles already stored keep their old text.
- Found during UAT of the above:
  - The "Awaiting my approval" count badge showed a red "0". It's now hidden at zero.
  - A `/tasks?tab=…` link opened while already on Tasks didn't switch tabs. It does now,
    and clicking a tab keeps the URL in step.

**Database / env vars:** none. **DevOps must do / expect:** nothing (client-only).

**Verified**
- Client tests: 153/153, including labels, field order, hidden fields, update rows, value
  formatting and the "Returned" badge.
- UAT on personal Vercel as test_editor:
  - Awaiting my approval shows "Nothing waiting for your approval.";
  - My requests shows #2 as "Returned" in crimson, and the status filter lists "Returned";
  - with filters that match nothing, it shows "No requests match. Try clearing the filters.";
  - #2's detail panel shows only the nine capitalization fields, with the form labels.
- UAT on personal Vercel as Krupal (2026-09-28), using two temporary rules that were
  removed straight afterwards; both requests were withdrawn and nothing was applied:
  - Edit Asset #6 on CI0724: Opening Accumulated Depreciation (Component 1)
    **₹21,598.50 → ₹0.00** was shown and highlighted (changed to zero, not hidden; paise
    kept). Unchanged fields were dimmed.
  - Masters #7 on "Medical Equipment-Dialysis": Default C1 Life **11 → —** (emptied) and
    Default C2 Life **7 → 0**. Only the submitted fields were listed.

### 6. Exports: paisa precision, Activity Log workbook, background exports
Commits: `5ca1a3c`, `c9425cb`, `26b382c`, `824e2bc`, `21533cd`, `f9cf8c5`, `1f5123f`

**What changed**
- **Amounts rounded to the paisa in exports only.** Register (CSV, .xlsx and the background
  CSV), Register Summary and Audit Reconciliation round amount columns to 2 decimals, round
  half up, with the same rule the Transfer & Depreciation export already uses, so the same
  asset matches across files.
  - Qty and Useful Life are never rounded (Useful Life holds part-years, e.g. 3.5).
  - Each export says "Amounts rounded to the paisa": in its first/note line, or as a
    header note on the Register .xlsx so its table still starts at row 1.
  - The calc engine, stored values and on-screen figures are unchanged.
- **Audit Reconciliation .xlsx:** amounts show 2 decimals, and the export reuses the
  figures the screen cached, so it matches the screen and no longer recomputes (it timed
  out on Vercel). On Vercel, a date not cached yet queues the pre-warm and says "still
  being prepared, try again shortly"; on Docker it computes and caches.
- **Register .xlsx:** Qty shows as a whole number; Useful Life keeps its 2-decimal format.
- **Activity Log export** is a two-sheet .xlsx:
  - **Events**: one row per entry, with date, user, module, action, FAR ID or master
    record, center, submitted by, approved by (every step: who, when, comment), a request
    link, reason and notes.
  - **Changes**: one row per changed field, with Event ID (linked to Events), form
    label, Old Value and New Value. Amounts are number cells with 2 decimals.
  - It covers creates, edits (including Edit Asset, whose before/after values weren't
    read before), deletes/undos and Masters.
  - The CSV (background export) uses the Changes layout, with each event's date, user
    and FAR ID repeated; an event with no field changes still gets one line.
  - Masters updates now also log which record they changed (they previously logged only
    the changed fields, so an update couldn't be tied to its center or role). This only
    applies to new entries.
- **Background exports:** the unfiltered Register Summary now runs as a background export
  (sliced by FAR ID, merged exactly; the file is identical to the direct export). The
  Activity Log already switched to background above 10,000 entries. Both show a progress
  percentage on the button while they run.
- **Found during live UAT, fixed:** background exports (Register, Activity Log) could run
  two hops at once: the page's poll plus the self-nudge, which only started working once
  the self-call fix above made nudges authenticate. Both hops wrote the same batches, and
  the first to finish closed the upload the other was still writing to. Seen live: a full
  Activity Log export counted 284,000 of 220,087 entries, then failed with "The specified
  multipart upload does not exist". Every background job now holds a lease (in
  `export_jobs.state`) while a hop runs, so one hop runs at a time.
- **Found during live UAT, fixed (older bug):** the Activity Log's paging cursor lost
  microseconds. The database driver returns timestamps as JavaScript dates (milliseconds
  only), and a bulk import writes thousands of entries with one identical microsecond
  timestamp. As a result:
  - the Activity Log screen's "load more" **silently skipped** entries (a test paging 2 at
    a time through 5 such entries returned only 2);
  - the oldest-first exports (direct .xlsx and background CSV) **re-read** the same batch
    over and over. This, not only the concurrent hops, is why the full export counted
    284,000 of 220,087 entries.
  - The cursor now carries Postgres's own full-precision timestamp.
- **Found while doing this:** without background-export storage (`EXPORT_S3_*` blank,
  as on the company's Docker server), a Register or Activity Log export over the
  background threshold used to **fail with an error**. It now falls back to the direct
  download, which has no time limit on Docker. The Register Summary behaves the same.

**Database (automatic on first boot)**
- `export_jobs.job_type` CHECK widened to allow `REGISTER_SUMMARY` (guarded, runs once).
- New nullable column `export_jobs.state` (JSONB): a Register Summary job's running sums
  between hops.

**Env vars:** none new. `EXPORT_S3_*` stay optional:
- unset (Docker today): exports download directly, with no time limit;
- set: large exports run in the background, as on Vercel.

**DevOps must do / expect:** nothing. Note for Finance: export layouts changed. The
Activity Log .xlsx now has two sheets (Events, Changes), and CSV amounts are rounded to
the paisa.

**Verified**
- Server tests: 1059/1059. They cover:
  - rounding half up (10000.125 → 10000.13) and extra decimals (2632.5678 → 2632.57);
  - Qty and Useful Life untouched, the notes, and the .xlsx Qty format;
  - Audit Reconciliation reading a sentinel value planted in its cache;
  - the Vercel cache-miss message;
  - every Activity Log shape (create, Masters update, disposal to "Disposed", Edit Asset
    before/after, delete) plus the approval links;
  - the Register Summary job merging 2-asset slices into a file byte-identical to the
    direct export, and its lease.
- Client tests: 155/155, including the 503 fallback and the progress percentage.
- UAT on personal Vercel (2026-09-28, 219,329 assets):
  - **Register CSV** (one center, 1,407 rows): no value with more than 2 decimals, and
    the note is present. **Register .xlsx**: Qty uses Excel's whole-number format,
    Useful Life keeps 2 decimals, and the header note is attached.
  - **Register Summary** (filtered): a row that exported `354939.93461044` /
    `411933.68571943935` before now exports `354939.93` / `411933.69`.
  - **Register Summary, unfiltered background export:** 219,329 assets in 3 min 37 s,
    with progress reported throughout. File: 3,019 lines, BOM, note, GRAND TOTAL of
    219,329 assets. Its 113-AP-GTR-PPP-C row is identical to the filtered direct export.
  - **Audit Reconciliation:** on a cold cache, "still being prepared" came back in
    217 ms (before this change: a 504 after 60 s). Once warm, the export takes 836 ms,
    in the 2-decimal format with the note. Its C1 Opening grand total (4,572,287,396.22)
    matches the Register Summary's to the paisa.
  - **Activity Log .xlsx:** Events and Changes sheets. An approved bulk row shows the
    submitter, "Step 1: … ("comment")", request #5 (a link) and the bulk file name.
  - **Activity Log, full background CSV:** 220,087 entries in 2 min 4 s. It holds exactly
    220,087 unique events, with no duplicated lines, in 3,961,496 lines (480 MB).
- **Size limit to know about:** the full-log CSV in the Changes layout (about 18 lines per
  capitalization) is 3.96 million lines, well over Excel's 1,048,576-row limit. It's a
  valid CSV for Power Query or a database, and filtered exports (date, category, FAR ID)
  stay small.

### 7. Sidebar scrolling; Activity Log export size
Commits: `fb0a102`, `866ee41`, `cfe05d8` (sidebar); `4b6ba74` (Activity Log export)

**What changed**
- **Sidebar:** since Tasks and Approval Workflows were added, the menu no longer fitted
  a laptop screen: "Admin" was cut off, and the mouse wheel over the sidebar didn't scroll
  it.
  - Only the menu list now scrolls; the logo/header and the "NephroAssets v1.0 • FAR"
    footer stay fixed.
  - Scrolling over the menu never scrolls the page behind it. It works with the wheel,
    trackpad, touch and keyboard (Tab through the items).
  - The scrollbar is hidden (Chrome, Edge, Firefox) but scrolling still works. A soft
    white fade shows at the bottom when more items are below, and at the top when
    scrolled down.
  - The current page's item is scrolled into view on load and navigation, so a page near
    the bottom (Admin) is never highlighted but hidden. Same in the collapsed
    (icon-only) sidebar.
- **Activity Log export size:**
  - Create entries list only the fields actually filled in: zero amounts and empty fields
    are left out of the Changes layout.
  - The export covers the **current financial year by default**. The date filters choose
    any other range, and the button shows the range it will export.
  - **The .xlsx never truncates.** Before this change nothing capped it: a very large
    workbook (possible on Docker, where large exports fell back to the direct
    download) would have passed Excel's 1,048,576-row limit, and Excel silently drops
    those rows when it "repairs" the file. Now:
    - the Changes sheet continues on "Changes (2)", "Changes (3)", ... (and Events on
      "Events (2)") at Excel's row limit;
    - a direct .xlsx over 50,000 entries is refused with a clear message: "too many for
      an Excel workbook ... narrow the date range, or use the CSV export";
    - without background storage (Docker), a large export is a directly streamed CSV
      (Changes layout), not a workbook.

**Database / env vars:** none. **DevOps must do / expect:** nothing.

**Verified**
- Server tests: 1066/1066, including zeros left out of creates, the 413 refusal, the
  streamed CSV, and sheets splitting into "Changes (2)"/"Changes (3)"/"Events (2)" with
  no row lost. Client tests: 155/155.
- UAT on personal Vercel (2026-09-28), sidebar measured in the browser:
  - **1366×700 (laptop):** the menu (613px) overflows its 591px area; on the Admin page
    it scrolled itself so Admin is fully visible. The scrollbar is 0px wide and
    `overscroll-behavior` is `contain`. A real mouse wheel over the sidebar scrolled the
    menu (22 → 0 → 22) while the page behind stayed at 0. The fades read correctly:
    top off and bottom on at the top, top on and bottom off at the bottom. Tab focus on
    the last item keeps it in view, and the footer stays fixed.
  - **Collapsed, 1366×500:** the rail scrolls, and the highlighted Admin icon stays
    visible after shrinking the window (a gap found during UAT: resizing didn't re-show
    the active item; fixed in `cfe05d8`).
  - **1920×1080:** everything fits, no fades, footer visible.
- UAT, Activity Log export:
  - The button shows "Exports 01-04-2026 to 31-03-2027 (current financial year)".
  - A capitalization's Changes rows are its 9 filled-in fields (zeros gone).
  - The whole financial year as .xlsx returns 413: "This export has 2,20,087 entries,
    too many for an Excel workbook (up to 50,000). Narrow the date range, or use the CSV
    export."
  - The full-log CSV went from 3.96M lines / 480 MB to **2.21M lines / 276 MB**, still
    with exactly 220,087 events.

### 8. Test tooling (developers only)
Commit: `ec1ca4f`. The test Postgres port can be overridden with `TEST_PG_PORT`, because
Windows can reserve the default port. No effect on the app, the image or the deployment.

### 9. Approval Workflows: reusable workflows + assignments
Commits: `26b0465` (server), `41fa17e` (client)

**What changed**
- Approval setup is no longer one list of rules per module. It is now:
  - **Workflows** (reusable): a name, a description, active/inactive, and ordered steps.
    Steps work exactly as before (users and/or roles, "any one" or "all must approve").
  - **Assignments**: one or more modules, submitter roles (or "any role"), an optional
    amount threshold, and the workflow to use.
- **Matching:** the most specific assignment wins: an amount threshold beats a specific
  role, which beats "any role"; between two thresholds that both apply, the higher one
  wins. Two assignments that are equally specific for the same entry are **refused when
  saved**, with a message naming the other assignment. No match = the change applies
  immediately, as before.
- **In-flight requests keep their workflow.** Each request stores the workflow (and now
  its version) as it stood at submission; editing the workflow only affects new requests.
- **Deactivating a workflow that is still assigned is blocked** ("still used by N
  assignments (…). Move them to another workflow or remove them first"), so no module is
  silently left without approval. An assignment can't use an inactive workflow.
- **Screen:** Approval Workflows now has three tabs:
  - **Workflows:** cards with the step chain (e.g. Finance Manager → CFO), "Used by N
    modules" and status. Create / Edit / Duplicate / Deactivate. Create and edit are a
    three-stage stepper (Name → Steps → Review, with a plain-English summary). Editing a
    workflow in use says "Used by N modules. Changes apply to new requests only."
  - **Assignments:** a table of assignments (module multi-select with "Select all asset
    modules", roles, optional amount, workflow), plus an overview matrix (modules × roles)
    showing which workflow applies in each cell, with amount tiers.
  - **Test a scenario:** pick module, submitter role and amount; shows the workflow and
    its approvers, or "No approval, applies immediately".
  - The "Flag requests waiting longer than N days" setting moved to the page header.
- **Activity Log:** a new **Approval Workflows** category logs every workflow create,
  edit, deactivate/reactivate and every assignment create, edit and removal: who, when,
  and old → new values (steps as readable text, e.g. "Finance Manager → CFO"). It is in
  the Activity Log export too. These entries are kept out of the Masters category.

**Database (automatic on first boot, `server/src/db/approvalsSchema.sql`)**
- New tables `approval_flows` (unique name, case-insensitive) and `approval_assignments`.
- New column `approval_config.legacy_rules_migrated` (default false).
- `master_activity_log` action CHECK widened for the workflow/assignment actions
  (guarded, runs once).
- **One-time conversion** (inside the locked schema update, flagged so it runs once per
  database): the existing per-module rules in `approval_workflows` become workflows +
  assignments. Identical step chains become one shared workflow; assignments identical
  but for the module are merged. Rules the old "first match" order could never reach are
  dropped, so every entry is routed exactly as before (tested case by case).
  - **Company database:** approvals have never been set up there, so the conversion
    creates nothing and just sets the flag.
  - **Forward-only and non-destructive:** `approval_workflows` is left untouched (no
    longer read or written), so an older build still boots against the upgraded database.

**Env vars:** none.

**DevOps must do / expect:** nothing. First boot adds the tables and runs the conversion
in well under a second. Behaviour is unchanged until an admin sets up workflows.

**Verified**
- Server tests: 1078/1078. New tests: matching precedence (including the real submission
  path agreeing with the scenario tester), the conflict block (on create, on edit, "any
  role" vs "any role", thresholds on modules without amounts), a tie that bypassed the
  check being refused at submission rather than guessed, the migration (merging, dropped
  unreachable rules, a 105-case grid of module × role × amount matching the old
  first-match result exactly, a second boot doing nothing, an empty table), snapshot
  stability when a workflow is edited mid-request (old request finishes on version 1,
  the next one gets version 2), the deactivation block, unique names, and the Activity
  Log entries with before → after.
- Client tests: 157/157 (summaries, matching and overview-matrix cells).
- Client and server builds pass.
- UAT on personal Vercel: pending (see the update below once done).

---

## Known limitations

- **Older Masters update entries don't say which item changed.** Until this release, a
  Masters update (center, sub classification, status or role) logged only the fields that
  changed, not which record they belong to. For example, "Description: Old → New" with no
  center code. Entries written from this release on record the item (the "FAR ID /
  Master" column in the Activity Log export). Older entries can't be recovered: that
  information was never stored.
- **The full Activity Log as CSV exceeds Excel's row limit.** The whole log (220,087
  entries today) is 2.21 million Changes rows, about twice Excel's 1,048,576-row limit.
  It's a valid CSV for Power Query or a database; for Excel, export a date range (the
  default is the current financial year). The .xlsx never truncates: it's refused above
  50,000 entries, and its sheets continue on "Changes (2)" and so on at Excel's limit.

## Release checklist (run before "push to company")

- [ ] Server and client tests pass; the client and server builds succeed.
- [ ] Docker upgrade rehearsal: a 219k-asset database on `9f32dfa` upgraded to the final
      commit, with first-boot time and the pre-warm pass measured.
- [ ] Rollback check: `9f32dfa` still boots and works against the upgraded database.
- [ ] No secrets or `.env` files in the diff; a fast-forward from `9f32dfa`.
- [ ] A consolidated DevOps message built from this file: current version, `pg_dump`
      backup, `git pull` + `docker compose up -d --build`, outside working hours,
      first-boot expectations, checks afterwards, rollback steps.
- [ ] Create tag `v1.2` once the deploy is confirmed.
