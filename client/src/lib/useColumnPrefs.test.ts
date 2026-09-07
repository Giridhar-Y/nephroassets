import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useColumnPrefs } from "./useColumnPrefs.js";
import type { AssetFilters } from "./types.js";

afterEach(() => {
  localStorage.clear();
});

const CTX = { asAt: "2026-04-01", fyStart: "2026-04-01" };

// useColumnPrefs takes `filters`/`replaceFilters` as plain params rather than reading
// FiltersContext itself (so it works as a hook without forcing every caller through a
// provider) — a bare renderHook with a no-op or capturing replaceFilters exercises it
// fully without needing a real FiltersProvider.
function setup(initialFilters: AssetFilters = {}, onReplaceFilters: (next: AssetFilters) => void = () => {}) {
  return renderHook(({ filters }: { filters: AssetFilters }) => useColumnPrefs(CTX, filters, onReplaceFilters), {
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

    // Persisted, not just in memory.
    const stored = JSON.parse(localStorage.getItem("nephroassets.register.views")!);
    expect(stored.views).toHaveLength(1);
    expect(stored.activeViewId).toBe(result.current.activeView!.id);
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

  it("ignores the old format once the new views array has already been written, even if empty", () => {
    localStorage.setItem("nephroassets.register.views", JSON.stringify({ views: [], activeViewId: null }));
    localStorage.setItem("nephroassets.register.myView", JSON.stringify({ order: [], visible: [], widths: {} }));
    const { result } = setup();
    expect(result.current.views).toEqual([]);
  });
});
