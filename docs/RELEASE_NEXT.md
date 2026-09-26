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
- **Database:** additive only (new tables and columns, one widened CHECK constraint).
  Applied automatically, once, on the first boot of the new image. No manual SQL.
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

### 5. Test tooling (developers only)
Commit: `ec1ca4f`. The test Postgres port can be overridden with `TEST_PG_PORT`, because
Windows can reserve the default port. No effect on the app, the image or the deployment.

---

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
