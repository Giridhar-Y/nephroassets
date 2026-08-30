import type { AssetListItem } from "./types.js";

/**
 * Re-orders an already-sorted, already-loaded page of Register rows so that a parent
 * and its children sit adjacent to each other, without changing the relative order of
 * anything else — the primary column sort (whatever `items` arrived in) is preserved for
 * every row that isn't part of a parent/child pair. A child is pulled out of its own
 * sort-order position and spliced in immediately after its parent, in the children's
 * original relative order; a child stays put if its parent isn't in `items` at all (not
 * loaded yet via "Load more", or filtered out) — there's nothing to group it under.
 * Parent/child links are strictly one level (server-enforced, see parentLink.ts), so no
 * recursion is needed here.
 */
export function groupParentChildRows(items: AssetListItem[]): AssetListItem[] {
  const loadedFarIds = new Set(items.map((i) => i.asset.farId));

  const childrenByParent = new Map<string, AssetListItem[]>();
  const deferredChildFarIds = new Set<string>();
  for (const item of items) {
    const parentFarId = item.asset.parentFarId;
    if (parentFarId && loadedFarIds.has(parentFarId)) {
      deferredChildFarIds.add(item.asset.farId);
      const siblings = childrenByParent.get(parentFarId);
      if (siblings) siblings.push(item);
      else childrenByParent.set(parentFarId, [item]);
    }
  }

  if (deferredChildFarIds.size === 0) return items;

  const result: AssetListItem[] = [];
  for (const item of items) {
    if (deferredChildFarIds.has(item.asset.farId)) continue;
    result.push(item);
    const children = childrenByParent.get(item.asset.farId);
    if (children) result.push(...children);
  }
  return result;
}
