import { useState } from "react";
import { fetchAssets } from "../api/client.js";
import type { AssetListItem } from "../lib/types.js";
import { describeAssetRelationship } from "../lib/assetRelationship.js";
import { FarIdAutocomplete } from "./FarIdAutocomplete.js";
import { DeleteIcon } from "../lib/icons.js";

/**
 * Shared "search and add, with parent/child auto-include" asset picker for
 * TransferModal/DisposalModal's form step — lets those modals be opened with an empty
 * selection (the dedicated Transfers/Disposals pages' New Transfer/New Disposal) as well
 * as a pre-populated one (Register's Record Movement, still fully editable from here).
 *
 * Adding an asset with active children fetches and adds them too, mirroring Register's
 * own checkbox behavior (toggleRegisterSelection) — purely for visibility ahead of
 * committing, since the server already cascades to every active child regardless (see
 * assetRelationship.ts's own comment). `autoAdded` tracks which currently-selected
 * FAR IDs were added by that auto-include (not picked directly), so removing a parent
 * only drops the children it pulled in, never one the user explicitly searched for and
 * added themselves — same distinction registerSelection.ts's autoSelected makes.
 */
export function AssetSelectionEditor({
  asAt,
  assets,
  autoAdded,
  onChange
}: {
  asAt: string;
  assets: AssetListItem[];
  autoAdded: Set<string>;
  onChange: (assets: AssetListItem[], autoAdded: Set<string>) => void;
}) {
  const [addingChildrenOf, setAddingChildrenOf] = useState<string | null>(null);

  async function handleAdd(item: AssetListItem) {
    if (assets.some((a) => a.asset.farId === item.asset.farId)) return;
    let next = [...assets, item];
    let nextAuto = autoAdded;

    if (item.asset.hasChildren) {
      setAddingChildrenOf(item.asset.farId);
      try {
        const res = await fetchAssets({
          asAt,
          conditions: [{ columnId: "parentFarId", type: "text", op: "equals", value: item.asset.farId }]
        });
        const newChildren = res.items.filter(
          (c) => c.asset.dateOfDisposal === null && !next.some((a) => a.asset.farId === c.asset.farId)
        );
        if (newChildren.length > 0) {
          next = [...next, ...newChildren];
          nextAuto = new Set(nextAuto);
          for (const c of newChildren) nextAuto.add(c.asset.farId);
        }
      } catch {
        // Best-effort preview only — the server still cascades the transfer/disposal to
        // every active child correctly even if this lookup fails, so the user just won't
        // see them listed ahead of time.
      } finally {
        setAddingChildrenOf(null);
      }
    }
    onChange(next, nextAuto);
  }

  function handleRemove(farId: string) {
    const removed = assets.find((a) => a.asset.farId === farId);
    let next = assets.filter((a) => a.asset.farId !== farId);
    const nextAuto = new Set(autoAdded);
    nextAuto.delete(farId);
    if (removed?.asset.hasChildren) {
      for (const a of assets) {
        if (a.asset.parentFarId === farId && nextAuto.has(a.asset.farId)) {
          next = next.filter((x) => x.asset.farId !== a.asset.farId);
          nextAuto.delete(a.asset.farId);
        }
      }
    }
    onChange(next, nextAuto);
  }

  return (
    <div>
      <FarIdAutocomplete asAt={asAt} placeholder="Search FAR ID to add…" onSelect={handleAdd} />
      {addingChildrenOf && <p className="mt-1 text-xs text-gray-400">Adding {addingChildrenOf}'s child assets…</p>}

      {assets.length > 0 && (
        <ul className="mt-3 max-h-52 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200">
          {assets.map((item) => {
            const relationship = describeAssetRelationship(item, assets);
            return (
              <li key={item.asset.farId} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-ink">{item.asset.farId}</span>
                    {relationship && (
                      <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                        {relationship}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-gray-500">{item.asset.assetDescription}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${item.asset.farId}`}
                  title="Remove"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() => handleRemove(item.asset.farId)}
                >
                  <DeleteIcon fontSize={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
