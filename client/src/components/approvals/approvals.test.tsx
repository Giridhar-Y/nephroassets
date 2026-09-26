import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalStatusBadge } from "./ApprovalStatusBadge.js";
import { ruleSummary } from "../../pages/WorkflowsPage.js";
import { approvalMessage, approvalSummary } from "../../lib/useApprovalPreview.js";
import type { Directory } from "../../api/approvals.js";
import { formatCurrency } from "../../lib/format.js";

afterEach(cleanup);

const DIR: Directory = {
  roles: [
    { id: 1, name: "Editor", active: true },
    { id: 2, name: "Finance Manager", active: true },
    { id: 3, name: "Admin", active: true }
  ],
  users: [{ id: 10, name: "CFO Priya", username: "priya", role: "admin", active: true }]
};

describe("workflow builder summary", () => {
  it("reads as plain English, matching Finance's example", () => {
    expect(
      ruleSummary(
        { name: "", initiatorRoleIds: [1], minAmount: null, steps: [{ rule: "any", assignees: [{ type: "role", id: 2 }] }, { rule: "any", assignees: [{ type: "user", id: 10 }] }] },
        "Capitalization",
        DIR
      )
    ).toBe("When an Editor submits a Capitalization: Finance Manager → CFO Priya");
  });

  it("includes the threshold, several initiator roles, and the any/all rule for multi-approver steps", () => {
    expect(
      ruleSummary(
        {
          name: "",
          initiatorRoleIds: [1, 3],
          minAmount: 1000000,
          steps: [{ rule: "all", assignees: [{ type: "role", id: 2 }, { type: "user", id: 10 }] }]
        },
        "Additions",
        DIR
      )
    ).toBe(`When an Editor or Admin submits an Additions of ${formatCurrency(1000000)} or more: Finance Manager and CFO Priya (all must approve)`);
  });
});

describe("ApprovalStatusBadge", () => {
  it("always pairs the status with a text label (never colour alone), plus the step for in-flight requests", () => {
    render(<ApprovalStatusBadge status="in_review" step={{ current: 1, total: 3 }} />);
    expect(screen.getByText(/In review/).textContent).toContain("Step 2 of 3");
    cleanup();
    render(<ApprovalStatusBadge status="rejected" />);
    expect(screen.getByText("Rejected")).toBeTruthy();
    cleanup();
    render(<ApprovalStatusBadge status="applied" step={{ current: 0, total: 2 }} />);
    expect(screen.getByText("Approved").textContent).not.toContain("Step");
  });
});

describe("approval messages after a save", () => {
  it("returns the server's 'Sent to … for approval' message for a captured entry, null for an applied one", () => {
    expect(approvalMessage({ pendingApproval: { requestId: 1, nextReviewers: "Finance Manager", message: "Sent to Finance Manager for approval." } })).toBe(
      "Sent to Finance Manager for approval."
    );
    expect(approvalMessage({ farId: "X", created: true })).toBeNull();
  });

  it("summarises a batch where several saves went for approval", () => {
    const pending = { pendingApproval: { requestId: 1, nextReviewers: "Finance Manager", message: "Sent to Finance Manager for approval." } };
    expect(approvalSummary([pending, pending, { farId: "Y" }])).toEqual({ pending: 2, message: "2 requests sent to Finance Manager for approval." });
  });
});
