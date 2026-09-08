import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useColumnPrefs } from "./useColumnPrefs.js";
import type { AssetFilters } from "./types.js";

afterEach(() => {
  localStorage.clear();
});

const CTX = { asAt: "2026-04-01", fyStart: "2026-04-01" };
const USER_ID = 1;

// useColumnPrefs takes `filters`/`replaceFilters` as plain params rather than reading
// FiltersContext itself (so it works as a hook without forcing every caller through a
// provider) — a bare renderHook with a no-op or capturing replaceFilters exercises it
// fully without needing a real FiltersProvider.
function setup(initialFilters: AssetFilters = {}, onReplaceFilters: (next: AssetFilters) => void = () => {}, userId = USER_ID) {
  return renderHook(({ filters }: { filters: AssetFilters }) => useColumnPrefs(CTX, filters, onReplaceFilters, userId), {
    initialProps: { filters: initialFilters }
  });
}

describe("useColumnPrefs: Saved Views", () => {
  it("starts with no views and a default, non-dirty layout when nothing is saved", () => {
    const { result } = setup();
    expect(result.current.views).toEqual([]);
    expect(result.current.activeView).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });

  it("toggling a column makes the draft dirty against the (implicit) default", () => {
    const { result } = setup();
    act(() => result.current.toggleColumn("serialNo"));
    expect(result.current.isDirty).toBe(true);
  });

  it("saveNewView creates a named view bundling columns AND the current filters, and becomes active", () => {
    const { result } = setup({ status: ["Active"] });
    act(() => result.current.toggleColumn("serialNo"));
    act(() => result.current.saveNewView("My Filtered View"));

    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0]!.name).toBe("My Filtered View");
    expect(result.current.views[0]!.filters).toEqual({ status: ["Active"] });
    expect(result.current.activeView?.name).toBe("My Filtered View");
    expect(result.current.isDirty).toBe(false);

    // Persisted, not just in memory — under THIS user's own scoped key.
    const stored = JSON.parse(localStorage.getItem(`nephroassets.register.views.${USER_ID}`)!);
    expect(stored.views).toHaveLength(1);
    expect(stored.activeViewId).toBe(result.current.activeView!.id);
  });

  it("keys Saved Views per user — a different user id starts with none of the first user's views", () => {
    const { result: userA } = setup({}, () => {}, 1);
    act(() => userA.current.saveNewView("User A's View"));
    expect(userA.current.views).toHaveLength(1);

    const { result: userB } = setup({}, () => {}, 2);
    expect(userB.current.views).toEqual([]);
  });

  it("saveNewView ignores a blank/whitespace-only name", () => {
    const { result } = setup();
    act(() => result.current.saveNewView("   "));
    expect(result.current.views).toEqual([]);
  });

  it("applyView restores the saved columns and calls replaceFilters with the saved filters", () => {
    let appliedFilters: AssetFilters | null = null;
    const { result } = setup({}, (next) => {
      appliedFilters = next;
    });
    act(() => result.current.toggleColumn("serialNo")); // serialNo is visible by default — this hides it
    act(() => result.current.saveNewView("View A"));
    const viewId = result.current.activeView!.id;

    act(() => result.current.resetToDefault());
    expect(result.current.activeView).toBeNull();
    expect(result.current.draft.visible).toContain("serialNo");

    act(() => result.current.applyView(viewId));
    expect(result.current.activeView?.id).toBe(viewId);
    expect(result.current.draft.visible).not.toContain("serialNo");
    expect(appliedFilters).toEqual({});
  });

  it("updateActiveView overwrites the active view's saved columns/filters with the current draft", () => {
    const { result } = setup();
    act(() => result.current.saveNewView("View A"));
    act(() => result.current.toggleColumn("parentFarId"));
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.updateActiveView());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.activeView?.visible).toEqual(result.current.draft.visible);
  });

  it("Update is meaningless with no active view and isConditionComplete-style guards silently no-op", () => {
    const { result } = setup();
    act(() => result.current.updateActiveView());
    expect(result.current.views).toEqual([]);
  });

  it("renameActiveView changes only the name, not the saved columns/filters", () => {
    const { result } = setup();
    act(() => result.current.saveNewView("Old Name"));
    const before = result.current.activeView;
    act(() => result.current.renameActiveView("New Name"));
    expect(result.current.activeView?.name).toBe("New Name");
    expect(result.current.activeView?.order).toEqual(before!.order);
    expect(result.current.views).toHaveLength(1);
  });

  it("deleteView removes it from the list without touching the current draft", () => {
    const { result } = setup();
    act(() => result.current.saveNewView("Temp View"));
    const id = result.current.activeView!.id;
    act(() => result.current.toggleColumn("qty"));
    const draftBefore = result.current.draft;

    act(() => result.current.deleteView(id));
    expect(result.current.views).toEqual([]);
    expect(result.current.activeView).toBeNull();
    expect(result.current.draft).toEqual(draftBefore);
  });

  it("resetToDefault clears activeView and restores the default column layout", () => {
    const { result } = setup();
    act(() => result.current.toggleColumn("serialNo"));
    act(() => result.current.saveNewView("View A"));
    act(() => result.current.resetToDefault());

    expect(result.current.activeView).toBeNull();
    expect(result.current.draft.visible).toContain("serialNo");
  });

  // Undo-toast support (ColumnPicker.tsx's "Reset to Default" toast) — the caller
  // captures {draft, activeViewId} right before calling resetToDefault(), then hands it
  // back to applySnapshot() to restore exactly that.
  it("applySnapshot restores an exact prior draft + active view after a reset", () => {
    const { result } = setup();
    act(() => result.current.toggleColumn("serialNo"));
    act(() => result.current.saveNewView("View A"));
    const snapshot = { draft: result.current.draft, activeViewId: result.current.activeView!.id };

    act(() => result.current.resetToDefault());
    expect(result.current.activeView).toBeNull();

    act(() => result.current.applySnapshot(snapshot));
    expect(result.current.activeView?.id).toBe(snapshot.activeViewId);
    expect(result.current.draft).toEqual(snapshot.draft);
  });

  it("migrates the old single-'My View' localStorage format into a named view on first load", () => {
    localStorage.setItem(
      "nephroassets.register.myView",
      JSON.stringify({ order: ["farId", "serialNo"], visible: ["farId"], widths: {} })
    );
    const { result } = setup();
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0]!.name).toBe("My View");
    expect(result.current.views[0]!.filters).toEqual({});
    expect(result.current.activeView?.name).toBe("My View");
  });

  it("ignores the old single-view format once this user's own scoped views array already exists, even if empty", () => {
    localStorage.setItem(`nephroassets.register.views.${USER_ID}`, JSON.stringify({ views: [], activeViewId: null }));
    localStorage.setItem("nephroassets.register.myView", JSON.stringify({ order: [], visible: [], widths: {} }));
    const { result } = setup();
    expect(result.current.views).toEqual([]);
  });

  // The actual bug this fix closes: real, named Saved Views written under the
  // pre-per-user-scoping shared key (from before this session's fix shipped) must not
  // silently vanish for a user whose browser still has them sitting there.
  it("migrates real Saved Views from the pre-per-user-scoping shared key into this user's own scoped key", () => {
    const legacyState = {
      views: [{ id: "v1", name: "Dialysis Machines View", order: ["farId"], visible: ["farId"], widths: {}, filters: {} }],
      activeViewId: "v1"
    };
    localStorage.setItem("nephroassets.register.views", JSON.stringify(legacyState));
    const { result } = setup();
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0]!.name).toBe("Dialysis Machines View");
    expect(result.current.activeView?.name).toBe("Dialysis Machines View");

    // Migrated into the new key, and the old shared key is gone so it's never re-read.
    expect(localStorage.getItem(`nephroassets.register.views.${USER_ID}`)).not.toBeNull();
    expect(localStorage.getItem("nephroassets.register.views")).toBeNull();
  });
});
