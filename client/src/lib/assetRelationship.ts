import type { AssetListItem } from "./types.js";

/**
 * Describes an item's parent/child relationship relative to the rest of a specific
 * selection (a Transfer/Disposal batch) — shown as a badge in TransferModal/
 * DisposalModal's asset picker and confirm-step table, so a multi-asset action's
 * parent/child ties are visible before committing. Purely informational: both
 * `POST /api/transfers` and `disposeWithChildren` already cascade to every active child
 * server-side regardless of what's explicitly selected — this only surfaces that to the
 * user ahead of time, it doesn't drive server behavior.
 */
export function describeAssetRelationship(item: AssetListItem, selection: AssetListItem[]): string | null {
  if (item.asset.parentFarId) return `Child of ${item.asset.parentFarId}`;
  if (item.asset.hasChildren) {
    const includedChildren = selection.filter((i) => i.asset.parentFarId === item.asset.farId).length;
    return includedChildren > 0 ? `Parent — ${includedChildren} child${includedChildren === 1 ? "" : "ren"} included` : "Parent";
  }
  return null;
}
