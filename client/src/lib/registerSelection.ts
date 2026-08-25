import type { AssetListItem } from "./types.js";

export interface SelectionState {
  selected: Set<string>;
  /** Subset of `selected` that was auto-checked because its parent was checked, not
   *  clicked directly — tracked separately so unchecking the parent only drops the
   *  children it added, never one the user explicitly checked themselves. */
  autoSelected: Set<string>;
}

/**
 * Register's checkbox toggle, parent/child aware: checking a parent's row auto-checks
 * every currently-loaded active child not already selected; unchecking it only drops the
 * children *this* toggle auto-added, leaving anything the user explicitly checked alone.
 * Only sees `items` currently loaded on the page — the server-side Transfer/Disposal/
 * Merge cascade still covers every child regardless of what's loaded here; this is a
 * UI-transparency layer on top of that, not a substitute for it.
 */
export function toggleRegisterSelection(items: AssetListItem[], farId: string, state: SelectionState): SelectionState {
  const selected = new Set(state.selected);
  const autoSelected = new Set(state.autoSelected);
  const turningOn = !selected.has(farId);

  if (turningOn) selected.add(farId);
  else selected.delete(farId);
  // Toggled directly, either way — no longer "auto".
  autoSelected.delete(farId);

  const toggled = items.find((i) => i.asset.farId === farId);
  if (!toggled?.asset.hasChildren) return { selected, autoSelected };

  const children = items.filter((i) => i.asset.parentFarId === farId && i.asset.dateOfDisposal === null);
  if (turningOn) {
    for (const child of children) {
      if (!selected.has(child.asset.farId)) {
        selected.add(child.asset.farId);
        autoSelected.add(child.asset.farId);
      }
    }
  } else {
    for (const child of children) {
      if (autoSelected.has(child.asset.farId)) {
        selected.delete(child.asset.farId);
        autoSelected.delete(child.asset.farId);
      }
    }
  }
  return { selected, autoSelected };
}
