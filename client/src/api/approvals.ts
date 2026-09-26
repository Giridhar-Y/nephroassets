import { request } from "./client.js";

// Approval workflows API — mirrors server/src/routes/approvals.ts.

export type ApprovalModule =
  | "capitalization"
  | "additions"
  | "disposals"
  | "transfers"
  | "editAsset"
  | "bulkCapitalization"
  | "bulkDisposals"
  | "bulkTransfers"
  | "bulkMerge"
  | "masters";

export type RequestStatus = "draft" | "pending" | "in_review" | "applying" | "applied" | "rejected" | "needs_attention" | "withdrawn";

export interface ModuleInfo {
  key: ApprovalModule;
  label: string;
  hasAmount: boolean;
}

export interface Assignee {
  type: "user" | "role";
  id: number;
}
export interface WorkflowStep {
  rule: "any" | "all";
  assignees: Assignee[];
}
export interface WorkflowRule {
  id?: number;
  name: string;
  initiatorRoleIds: number[];
  minAmount: number | null;
  steps: WorkflowStep[];
}
export interface WorkflowRuleRow extends WorkflowRule {
  id: number;
  module: ApprovalModule;
  position: number;
  updatedAt: string;
}

export interface Directory {
  users: Array<{ id: number; name: string; username: string; role: string; active: boolean }>;
  roles: Array<{ id: number; name: string; active: boolean }>;
}

export interface TaskItem {
  id: number;
  module: ApprovalModule;
  moduleLabel: string;
  kind: "single" | "bulk";
  summary: string;
  farIds: string[];
  farIdCount: number;
  centers: string[];
  amount: number | null;
  status: RequestStatus;
  currentStep: number;
  stepsTotal: number;
  currentStepLabel: string | null;
  makerId: number;
  makerName: string;
  createdAt: string;
  updatedAt: string;
  ageDays: number;
  aging: boolean;
  canAct: boolean;
}

export interface BulkProgress {
  phase: "validating" | "applying" | "done";
  chunksDone: number;
  chunksTotal: number;
  rowsDone: number;
  rowsTotal: number;
  errors: Array<{ row: number; message: string }>;
}

export interface RequestDetail extends TaskItem {
  blockReason: string | null;
  payload: { method?: string; url?: string; body?: Record<string, unknown> | null; filename?: string; path?: string };
  before: Record<string, unknown> | null;
  lastError: string | null;
  cycle: number;
  appliedAt: string | null;
  steps: Array<{
    rule: "any" | "all";
    label: string;
    assignees: Array<Assignee & { label: string }>;
    state: "done" | "current" | "rejected" | "upcoming";
    approvals: Array<{ by: string; at: string }>;
  }>;
  timeline: Array<{ id: number; action: string; cycle: number; step: number | null; by: string; comment: string | null; details: Record<string, unknown> | null; at: string }>;
  permissions: { canWithdraw: boolean; canResubmit: boolean; canReassign: boolean };
  bulk: null | {
    rows: number;
    amount: number | null;
    updates: number;
    creates: number;
    byCenter: Array<{ center: string; rows: number; amount: number | null }>;
    progress: BulkProgress | null;
  };
}

export interface BulkRowsPage {
  total: number;
  page: number;
  pageSize: number;
  rows: Array<{ row: number; farId: string | null; center: string | null; amount: number | null; data: Record<string, unknown>; before: Record<string, unknown> | null }>;
}

/** A write route's answer when a workflow captured the entry instead of applying it. */
export interface PendingApproval {
  requestId: number;
  nextReviewers: string;
  message: string;
}

export function isPendingApproval(value: unknown): value is { pendingApproval: PendingApproval } {
  return typeof value === "object" && value !== null && "pendingApproval" in value;
}

export const fetchApprovalModules = () => request<ModuleInfo[]>("/api/approvals/modules");
export const fetchWorkflows = () => request<{ rules: WorkflowRuleRow[]; agingDays: number }>("/api/approvals/workflows");
export const saveModuleRules = (module: ApprovalModule, rules: WorkflowRule[]) =>
  request<{ rules: WorkflowRuleRow[] }>(`/api/approvals/workflows/${module}`, { method: "PUT", body: JSON.stringify({ rules }) });
export const saveAgingDays = (agingDays: number) =>
  request<{ agingDays: number }>("/api/approvals/config", { method: "PUT", body: JSON.stringify({ agingDays }) });
export const fetchDirectory = () => request<Directory>("/api/approvals/directory");
export const fetchApprovalPreview = (module: ApprovalModule, amount?: number) =>
  request<{ applies: boolean; nextReviewers?: string; steps?: string[] }>(
    `/api/approvals/preview?module=${module}${amount !== undefined && Number.isFinite(amount) ? `&amount=${amount}` : ""}`
  );

export type TaskTab = "mine" | "requests" | "all";
export const fetchTasks = (tab: TaskTab, filters: { module?: string; center?: string; status?: string; aging?: boolean }) => {
  const p = new URLSearchParams({ tab });
  if (filters.module) p.set("module", filters.module);
  if (filters.center) p.set("center", filters.center);
  if (filters.status) p.set("status", filters.status);
  if (filters.aging) p.set("aging", "true");
  return request<{ items: TaskItem[]; agingDays: number }>(`/api/approvals/tasks?${p}`);
};
export const fetchTaskCount = () => request<{ awaiting: number; aging: number }>("/api/approvals/tasks/count");
export const fetchOpenRequests = (opts: { module?: string; farId?: string }) => {
  const p = new URLSearchParams();
  if (opts.module) p.set("module", opts.module);
  if (opts.farId) p.set("farId", opts.farId);
  return request<{ items: TaskItem[] }>(`/api/approvals/open?${p}`);
};
export const fetchRequest = (id: number) => request<RequestDetail>(`/api/approvals/requests/${id}`);
export const fetchBulkRows = (id: number, page: number, q: string) =>
  request<BulkRowsPage>(`/api/approvals/requests/${id}/rows?page=${page}&pageSize=50&q=${encodeURIComponent(q)}`);
export const decideRequest = (id: number, decision: "approve" | "reject", body: { step: number; cycle: number; comment?: string }) =>
  request<RequestDetail>(`/api/approvals/requests/${id}/${decision}`, { method: "POST", body: JSON.stringify(body) });
export const withdrawRequest = (id: number) => request<RequestDetail>(`/api/approvals/requests/${id}/withdraw`, { method: "POST" });
export const reassignRequest = (id: number, assignees: Assignee[], rule?: "any" | "all") =>
  request<RequestDetail>(`/api/approvals/requests/${id}/reassign`, { method: "POST", body: JSON.stringify({ assignees, rule }) });
/** Re-sends the maker's corrected entry through its original route, marked as a resubmission. */
export const resubmitSingle = (detail: RequestDetail, body: Record<string, unknown>) =>
  request<{ pendingApproval: PendingApproval }>(detail.payload.url!, {
    method: detail.payload.method,
    body: JSON.stringify(body),
    headers: { "x-approval-resubmit": String(detail.id) }
  });
export const startBulkResubmit = (id: number) => request<{ batchToken: string }>(`/api/approvals/requests/${id}/bulk-resubmit`, { method: "POST" });
export const finalizeBulk = (batchToken: string) =>
  request<{ requestId: number; status: "pending" | "applying" | "empty"; message: string }>("/api/approvals/bulk/finalize", {
    method: "POST",
    body: JSON.stringify({ batchToken })
  });

export interface ServerNotification {
  id: number;
  kind: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}
export const fetchServerNotifications = () => request<{ items: ServerNotification[]; unread: number }>("/api/notifications");
export const markServerNotificationsRead = () => request<{ ok: boolean }>("/api/notifications/read", { method: "POST", body: JSON.stringify({}) });
export const clearServerNotifications = () => request<{ ok: boolean }>("/api/notifications/clear", { method: "POST" });

export const STATUS_LABELS: Record<RequestStatus, string> = {
  draft: "Draft",
  pending: "Pending",
  in_review: "In review",
  applying: "Applying",
  applied: "Approved",
  rejected: "Rejected",
  needs_attention: "Needs attention",
  withdrawn: "Withdrawn"
};
