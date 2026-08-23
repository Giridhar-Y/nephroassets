import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FiltersProvider, useFilters } from "./FiltersContext.js";
import { clearPersistedUiState } from "./persistedUiState.js";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  cleanup();
});

// FiltersContext is mounted above the route switch (App.tsx), so unlike Register's
// column prefs or the sidebar's collapsed state, it doesn't unmount on logout and
// wouldn't otherwise notice clearPersistedUiState() clearing sessionStorage out from
// under its already-loaded React state — it has to listen for the sweep event directly.
function Probe() {
  const { filters, setFilter } = useFilters();
  return (
    <div>
      <span data-testid="search">{filters.search ?? ""}</span>
      <button type="button" onClick={() => setFilter("search", "FAR-1")}>
        Set filter
      </button>
    </div>
  );
}

describe("FiltersContext: resets in-memory state when persisted UI state is cleared", () => {
  it("clears filters already held in React state, not just sessionStorage", async () => {
    render(
      <FiltersProvider>
        <Probe />
      </FiltersProvider>
    );

    act(() => screen.getByText("Set filter").click());
    expect(screen.getByTestId("search").textContent).toBe("FAR-1");
    expect(sessionStorage.getItem("nephroassets.filters")).toContain("FAR-1");

    act(() => clearPersistedUiState());

    expect(screen.getByTestId("search").textContent).toBe("");
    expect(sessionStorage.getItem("nephroassets.filters")).toBeNull();
  });
});
