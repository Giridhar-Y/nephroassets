-- Approval workflows (maker-checker). Idempotent: applied by pool.ts's applySchema() on
-- every schema-changing deploy and by the test bootstrap after schema.sql. See
-- server/src/approvals/ for how these are used.
--
-- The core rule: a pending entry lives ONLY in change_requests (+ its chunk/row tables for
-- bulk files). Nothing is written to assets/transfers/masters until the final approval,
-- when the original request is replayed through its own route. So far_calc_component()
-- and every report never see pending data.

-- One workflow RULE per row. A module can have several; they're checked in `position`
-- order and the first whose initiator roles include the maker's role (and whose optional
-- amount threshold the entry meets) wins. No matching rule = applied directly, as before.
CREATE TABLE IF NOT EXISTS approval_workflows (
  id                  BIGSERIAL PRIMARY KEY,
  module              TEXT NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  position            INTEGER NOT NULL DEFAULT 0,
  initiator_role_ids  BIGINT[] NOT NULL,
  min_amount          NUMERIC,
  -- [{ "rule": "any" | "all", "assignees": [{ "type": "user" | "role", "id": <number> }] }]
  steps               JSONB NOT NULL,
  updated_by          BIGINT REFERENCES users(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_workflows_module ON approval_workflows (module, position);

CREATE TABLE IF NOT EXISTS approval_config (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  aging_days  INTEGER NOT NULL DEFAULT 3 CHECK (aging_days >= 1)
);
INSERT INTO approval_config (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS change_requests (
  id                 BIGSERIAL PRIMARY KEY,
  module             TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('single', 'bulk')),
  summary            TEXT NOT NULL,
  far_ids            TEXT[] NOT NULL DEFAULT '{}',
  centers            TEXT[] NOT NULL DEFAULT '{}',
  amount             NUMERIC,
  -- single: { method, url, body } — replayed as-is on approval. bulk: { path, filename }.
  payload            JSONB NOT NULL,
  -- What the entry changes, as it stood when submitted (edits/updates) — for the
  -- approver's before/after view.
  before             JSONB,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'in_review', 'applying', 'applied', 'rejected', 'needs_attention', 'withdrawn')),
  -- The matched workflow, frozen at submission: { workflowId, name, steps: [{ rule, assignees: [{ type, id, label }] }] }.
  -- Editing the workflow later never changes a request already in flight; reassignment
  -- edits this snapshot (and is logged).
  workflow_snapshot  JSONB,
  current_step       INTEGER NOT NULL DEFAULT 0,
  -- Bumped on every resubmission; approvals only count within the current cycle.
  cycle              INTEGER NOT NULL DEFAULT 1,
  step_started_at    TIMESTAMPTZ,
  maker_id           BIGINT NOT NULL REFERENCES users(id),
  batch_token        TEXT,
  -- bulk apply job: { phase, chunksDone, chunksTotal, rowsDone, rowsTotal, errors: [...] }
  apply_progress     JSONB,
  apply_lease_until  TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests (status);
CREATE INDEX IF NOT EXISTS idx_change_requests_maker ON change_requests (maker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_requests_far_ids ON change_requests USING GIN (far_ids);
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_requests_batch ON change_requests (maker_id, batch_token) WHERE batch_token IS NOT NULL;

-- Append-only decision trail: submit, approve, reject, resubmit, withdraw, reassign,
-- apply, apply_failed.
CREATE TABLE IF NOT EXISTS change_request_actions (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  cycle       INTEGER NOT NULL,
  step        INTEGER,
  actor_id    BIGINT REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'resubmit', 'withdraw', 'reassign', 'apply', 'apply_failed')),
  comment     TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_change_request_actions_request ON change_request_actions (request_id, id);

-- Bulk files: each uploaded chunk stored byte-for-byte (so the approved apply replays
-- exactly what was reviewed), plus one row per data row for the paged preview/summary.
CREATE TABLE IF NOT EXISTS change_request_chunks (
  request_id    BIGINT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  chunk_no      INTEGER NOT NULL,
  filename      TEXT NOT NULL,
  content       BYTEA NOT NULL,
  row_offset    INTEGER NOT NULL DEFAULT 0,
  row_count     INTEGER NOT NULL,
  validated_at  TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ,
  result        JSONB,
  PRIMARY KEY (request_id, chunk_no)
);

CREATE TABLE IF NOT EXISTS change_request_rows (
  request_id  BIGINT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  row_no      INTEGER NOT NULL,
  chunk_no    INTEGER NOT NULL,
  far_id      TEXT,
  center      TEXT,
  amount      NUMERIC,
  data        JSONB NOT NULL,
  before      JSONB,
  PRIMARY KEY (request_id, row_no)
);

-- Server-side notifications (the header bell used to be browser-only), so a maker sees
-- a rejection and an approver sees a new task from any device.
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  link        TEXT,
  request_id  BIGINT REFERENCES change_requests(id) ON DELETE CASCADE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

-- Edit Asset is now logged (before/after) in asset_activity_log. Widens the action CHECK
-- once, guarded on the constraint's own definition.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asset_activity_log_action_check' AND pg_get_constraintdef(oid) LIKE '%asset_edit%'
  ) THEN
    ALTER TABLE asset_activity_log DROP CONSTRAINT IF EXISTS asset_activity_log_action_check;
    ALTER TABLE asset_activity_log ADD CONSTRAINT asset_activity_log_action_check
      CHECK (action IN ('capitalization_create', 'addition_create', 'transfer_create', 'disposal_create', 'asset_edit'));
  END IF;
END $$;

-- An entry written by an approved change request's apply carries that request's id, so
-- the Activity Log can show every approver (step, who, when, comment), not only the maker.
ALTER TABLE asset_activity_log ADD COLUMN IF NOT EXISTS approval_request_id BIGINT;
ALTER TABLE master_activity_log ADD COLUMN IF NOT EXISTS approval_request_id BIGINT;
