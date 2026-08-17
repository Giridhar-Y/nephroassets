import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AssetListItem } from "../lib/types.js";
import type { ColumnDef } from "../lib/columns.js";
import { Tooltip } from "./Tooltip.js";
import { EmptyIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";

const ROW_HEIGHT = 40;

export interface AssetGridProps {
  items: AssetListItem[];
  columns: ColumnDef[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  emptyTitle?: string;
  emptyHint?: string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleRow?: (farId: string) => void;
  onToggleAll?: () => void;
}

export function AssetGrid({
  items,
  columns,
  loading,
  error,
  hasMore,
  onLoadMore,
  onRetry,
  emptyTitle = "No assets match these filters.",
  emptyHint = "Try widening the filters above.",
  selectable = false,
  selected,
  onToggleRow,
  onToggleAll
}: AssetGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  });

  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    const last = virtualItems[virtualItems.length - 1];
    if (hasMore && last && last.index >= items.length - 20) {
      onLoadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.getVirtualItems(), items.length, hasMore]);

  const checkboxWidth = selectable ? 40 : 0;

  return (
    <>
      {error && (
        <div className="flex items-center gap-1.5 border-b border-red-100 bg-red-50 px-6 py-2 text-sm text-red-700">
          <ErrorIcon fontSize={15} />
          {error}{" "}
          <button className="flex items-center gap-1 font-semibold underline" onClick={onRetry}>
            <RetryIcon fontSize={13} />
            Retry
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" ref={parentRef}>
        <div style={{ minWidth: columns.reduce((sum, c) => sum + c.width, checkboxWidth) }}>
          <div className="sticky top-0 z-10 flex border-b-2 border-gray-300 bg-gray-50">
            {selectable && (
              <div className="flex h-9 w-10 shrink-0 items-center justify-center">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={items.length > 0 && selected?.size === items.length}
                  onChange={onToggleAll}
                />
              </div>
            )}
            {columns.map((col) => (
              <div
                key={col.id}
                className={`flex h-9 shrink-0 items-center px-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 ${
                  col.align === "right" ? "justify-end" : ""
                }`}
                style={{ width: col.width }}
              >
                {col.tooltip ? <Tooltip text={col.tooltip}>{col.label}</Tooltip> : col.label}
              </div>
            ))}
          </div>

          {loading ? (
            <div>
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} className="flex border-b border-gray-100" style={{ height: ROW_HEIGHT }}>
                  {selectable && <div className="flex w-10 shrink-0 items-center justify-center" />}
                  {columns.map((col) => (
                    <div key={col.id} className="flex shrink-0 items-center px-3" style={{ width: col.width }}>
                      <div className="h-3 w-3/4 animate-pulse rounded bg-gray-100" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
              <EmptyIcon fontSize={28} className="text-gray-300" />
              <p className="text-sm font-medium text-gray-600">{emptyTitle}</p>
              <p className="text-xs text-gray-400">{emptyHint}</p>
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index]!;
                const isSelected = selected?.has(item.asset.farId) ?? false;
                return (
                  <div
                    key={item.asset.farId}
                    data-testid="register-row"
                    data-far-id={item.asset.farId}
                    className={`absolute left-0 top-0 flex w-full border-b border-gray-100 text-sm ${
                      isSelected ? "bg-accent-light" : virtualRow.index % 2 === 1 ? "bg-gray-50/60" : "bg-white"
                    }`}
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {selectable && (
                      <div className="flex w-10 shrink-0 items-center justify-center">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          checked={isSelected}
                          onChange={() => onToggleRow?.(item.asset.farId)}
                        />
                      </div>
                    )}
                    {columns.map((col) => (
                      <div
                        key={col.id}
                        data-testid={`cell-${col.id}`}
                        className={`flex shrink-0 items-center truncate px-3 ${
                          col.align === "right" ? "justify-end tabular-nums" : ""
                        }`}
                        style={{ width: col.width }}
                        title={col.render(item)}
                      >
                        {col.render(item)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
