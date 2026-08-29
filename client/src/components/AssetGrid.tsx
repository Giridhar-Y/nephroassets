import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AssetListItem } from "../lib/types.js";
import { COLUMN_GROUPS, type ColumnDef, type ColumnGroupId } from "../lib/columns.js";
import { Tooltip } from "./Tooltip.js";
import {
  ChevronDownIcon,
  CollapseExpandIcon,
  DeleteIcon,
  EditIcon,
  EmptyIcon,
  ErrorIcon,
  ExpandIcon,
  LinkIcon,
  RetryIcon,
  ViewIcon
} from "../lib/icons.js";

const ROW_HEIGHT = 40;
const GROUP_BAND_HEIGHT = 26;
const MIN_COLUMN_WIDTH = 60;
const COLLAPSED_GROUP_WIDTH = 110;

// FAR ID stays visible while scrolling horizontally through the wider currency columns —
// it's the one thing you need to know "which row am I looking at". Every pinned cell
// (header and body, all row states) must use a fully OPAQUE background — see `rowBg`
// below — or the scrolling content behind it bleeds through the sticky layer.
const PINNED_COLUMN_IDS = new Set(["farId"]);

// The default border between adjacent columns; upgraded to a heavier one wherever two
// different groups meet — replacing the color-band approach with typography + borders,
// per request. Group-band segments never get the thin variant since two of them are
// only ever adjacent when they're already different groups.
const THIN_DIVIDER = "border-r border-gray-100";
const GROUP_DIVIDER = "border-r-2 border-gray-300";

type Slot = { kind: "column"; col: ColumnDef } | { kind: "collapsed"; groupId: ColumnGroupId; width: number };

// Collapsing a group replaces its run of real columns with one narrow placeholder slot
// — reordering (drag or the picker) can scatter one group's columns non-contiguously, in
// which case this just collapses each contiguous run it finds separately, same tolerance
// the group band itself already has.
function buildSlots(columns: ColumnDef[], collapsedGroups: Set<ColumnGroupId>): Slot[] {
  const slots: Slot[] = [];
  let i = 0;
  while (i < columns.length) {
    const col = columns[i]!;
    if (collapsedGroups.has(col.group)) {
      const g = col.group;
      while (i < columns.length && columns[i]!.group === g) i++;
      slots.push({ kind: "collapsed", groupId: g, width: COLLAPSED_GROUP_WIDTH });
    } else {
      slots.push({ kind: "column", col });
      i++;
    }
  }
  return slots;
}

function slotWidth(slot: Slot): number {
  return slot.kind === "column" ? slot.col.width : slot.width;
}

function slotGroup(slot: Slot): ColumnGroupId {
  return slot.kind === "column" ? slot.col.group : slot.groupId;
}

// True for the last slot of each contiguous group run (and never for the final slot
// overall, which has no next column to divide from) — the heavier group-boundary border
// goes on exactly these.
function computeGroupBoundaries(slots: Slot[]): boolean[] {
  return slots.map((slot, i) => {
    const next = slots[i + 1];
    if (!next) return false;
    return slotGroup(slot) !== slotGroup(next);
  });
}

interface BandSegment {
  key: string;
  groupId: ColumnGroupId;
  width: number;
  collapsed: boolean;
  /** Present only for a segment that's a single pinned column — rendered as its own
   *  sticky cell rather than merged into a wider run, since a run's flex width would
   *  otherwise pin far more of the band than intended. */
  pinnedLeft?: number;
  showLabel: boolean;
}

function buildBandSegments(slots: Slot[], pinnedLeft: Map<string, number>): BandSegment[] {
  const segments: BandSegment[] = [];
  let prevGroup: ColumnGroupId | null = null;
  let i = 0;
  while (i < slots.length) {
    const slot = slots[i]!;
    if (slot.kind === "collapsed") {
      segments.push({
        key: `collapsed-${slot.groupId}-${i}`,
        groupId: slot.groupId,
        width: slot.width,
        collapsed: true,
        showLabel: true
      });
      prevGroup = slot.groupId;
      i++;
      continue;
    }
    const col = slot.col;
    const pinned = pinnedLeft.get(col.id);
    if (pinned !== undefined) {
      segments.push({
        key: col.id,
        groupId: col.group,
        width: col.width,
        collapsed: false,
        pinnedLeft: pinned,
        showLabel: col.group !== prevGroup
      });
      prevGroup = col.group;
      i++;
      continue;
    }
    const startGroup = col.group;
    const startId = col.id;
    let width = 0;
    while (i < slots.length) {
      const s = slots[i]!;
      if (s.kind !== "column" || s.col.group !== startGroup || pinnedLeft.get(s.col.id) !== undefined) break;
      width += s.col.width;
      i++;
    }
    segments.push({ key: startId, groupId: startGroup, width, collapsed: false, showLabel: startGroup !== prevGroup });
    prevGroup = startGroup;
  }
  return segments;
}

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
  headerFilters?: Partial<Record<string, ReactNode>>;
  /** Renders a small "View Lifecycle" link at the end of each row when provided — a real
   *  anchor (via react-router's `Link`) opened in a new tab, not a programmatic
   *  navigation, so right-click/middle-click/Ctrl+click all behave as users expect and
   *  Register stays exactly where it was. Return the in-app path, e.g. `/assets/${farId}`. */
  getAssetHref?: (farId: string) => string;
  /** Renders an "Edit" action alongside View Lifecycle when provided — opens whatever
   *  the caller wants (typically EditAssetModal) for that row's FAR ID. */
  onEditAsset?: (farId: string) => void;
  /** Renders a Global-Admin-only delete/undo action when provided — the caller is
   *  responsible for the role check (this component doesn't know about roles) and for
   *  what "delete" means on its own page (Capitalization Log deletes the whole asset,
   *  Additions/Disposal Log undo just that part). `deleteActionLabel` sets the
   *  button's tooltip/aria-label (defaults to "Delete"). */
  onDeleteAsset?: (farId: string) => void;
  deleteActionLabel?: string;
  /** Drag-to-resize a column's header edge. Omit to disable resizing (e.g. pages using a
   *  fixed, non-persisted column set). */
  onResizeColumn?: (id: string, width: number) => void;
  /** Drag-and-drop a header to reorder columns; `beforeId` is the column it was dropped
   *  in front of. Omit to disable drag reordering. */
  onReorderColumn?: (id: string, beforeId: string) => void;
  /** Renders a second sticky row above the column-name header, banding contiguous runs
   *  of same-group columns (typography + a heavier border, no color) with a collapse
   *  chevron per group — Register only (39 columns is where a reader actually needs the
   *  extra orientation; smaller curated views elsewhere don't). */
  showGroupBand?: boolean;
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
  onToggleAll,
  headerFilters,
  getAssetHref,
  onEditAsset,
  onDeleteAsset,
  deleteActionLabel = "Delete",
  onResizeColumn,
  onReorderColumn,
  showGroupBand = false
}: AssetGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<ColumnGroupId>>(new Set());

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

  // Exiting full screen with Escape matches every other overlay in this app.
  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  function startResize(e: React.MouseEvent, colId: string, startWidth: number) {
    if (!onResizeColumn) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    function onMouseMove(moveEvent: MouseEvent) {
      onResizeColumn!(colId, Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX)));
    }
    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function toggleGroupCollapse(groupId: ColumnGroupId) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  const checkboxWidth = selectable ? 40 : 0;
  const actionWidth = (getAssetHref ? 40 : 0) + (onEditAsset ? 40 : 0) + (onDeleteAsset ? 40 : 0);

  // Left offset for each pinned column, so they stack correctly (checkbox, then FAR ID,
  // then Asset Description) instead of overlapping when horizontally scrolled. Collapsing
  // a group never affects this — a collapsible group never contains a pinned column.
  const pinnedLeft = new Map<string, number>();
  let pinnedOffset = checkboxWidth;
  for (const col of columns) {
    if (PINNED_COLUMN_IDS.has(col.id)) {
      pinnedLeft.set(col.id, pinnedOffset);
      pinnedOffset += col.width;
    }
  }

  const slots = showGroupBand ? buildSlots(columns, collapsedGroups) : columns.map((col): Slot => ({ kind: "column", col }));
  const groupBoundaries = computeGroupBoundaries(slots);
  const bandSegments = showGroupBand ? buildBandSegments(slots, pinnedLeft) : [];

  const content = (
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
        <div style={{ minWidth: slots.reduce((sum, s) => sum + slotWidth(s), checkboxWidth + actionWidth) }}>
          {showGroupBand && (
            <div className="sticky top-0 z-10 flex border-b border-gray-300 bg-white" style={{ height: GROUP_BAND_HEIGHT }}>
              {selectable && <div className="sticky left-0 z-20 h-full w-10 shrink-0 bg-white" style={{ left: 0 }} />}
              {bandSegments.map((seg, i) => {
                const group = COLUMN_GROUPS.find((g) => g.id === seg.groupId)!;
                const isLast = i === bandSegments.length - 1;
                const divider = isLast ? "" : GROUP_DIVIDER;
                const clickable = seg.showLabel && group.collapsible;
                return (
                  <div
                    key={seg.key}
                    className={`flex h-full shrink-0 items-center justify-center bg-white text-[10px] font-bold uppercase tracking-wide text-gray-600 ${divider} ${
                      seg.pinnedLeft !== undefined ? "sticky z-20" : ""
                    }`}
                    style={{ width: seg.width, left: seg.pinnedLeft }}
                  >
                    {seg.showLabel &&
                      (clickable ? (
                        <button
                          type="button"
                          onClick={() => toggleGroupCollapse(seg.groupId)}
                          className="flex h-full w-full items-center justify-center gap-1 truncate px-2 hover:bg-gray-50"
                          aria-label={seg.collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                          title={seg.collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                        >
                          {seg.collapsed ? (
                            <span className="truncate">+ {group.abbrev}</span>
                          ) : (
                            <>
                              <span className="truncate">{group.label}</span>
                              <ChevronDownIcon fontSize={12} className="shrink-0" />
                            </>
                          )}
                        </button>
                      ) : (
                        <span className="truncate px-2">{group.label}</span>
                      ))}
                  </div>
                );
              })}
              {actionWidth > 0 && <div className="h-full shrink-0 bg-white" style={{ width: actionWidth }} />}
            </div>
          )}
          <div
            className="sticky z-10 flex border-b-2 border-gray-300 bg-gray-50"
            style={{ top: showGroupBand ? GROUP_BAND_HEIGHT : 0 }}
          >
            {selectable && (
              <div
                className="sticky left-0 z-20 flex h-9 w-10 shrink-0 items-center justify-center bg-gray-50"
                style={{ left: 0 }}
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={items.length > 0 && selected?.size === items.length}
                  onChange={onToggleAll}
                />
              </div>
            )}
            {slots.map((slot, i) => {
              const divider = i === slots.length - 1 ? "" : groupBoundaries[i] ? GROUP_DIVIDER : THIN_DIVIDER;
              if (slot.kind === "collapsed") {
                const group = COLUMN_GROUPS.find((g) => g.id === slot.groupId)!;
                return (
                  <div
                    key={`collapsed-header-${slot.groupId}-${i}`}
                    className={`flex h-9 shrink-0 items-center justify-center bg-gray-50 text-[11px] text-gray-300 ${divider}`}
                    style={{ width: slot.width }}
                  >
                    {group.abbrev}
                  </div>
                );
              }
              const col = slot.col;
              const filter = headerFilters?.[col.id];
              const pinnedOffset = pinnedLeft.get(col.id);
              return (
                <div
                  key={col.id}
                  draggable={!!onReorderColumn}
                  onDragStart={(e) => e.dataTransfer.setData("text/column-id", col.id)}
                  onDragOver={(e) => {
                    if (!onReorderColumn) return;
                    e.preventDefault();
                    if (dragOverId !== col.id) setDragOverId(col.id);
                  }}
                  onDragLeave={() => setDragOverId((prev) => (prev === col.id ? null : prev))}
                  onDrop={(e) => {
                    if (!onReorderColumn) return;
                    e.preventDefault();
                    setDragOverId(null);
                    const draggedId = e.dataTransfer.getData("text/column-id");
                    if (draggedId) onReorderColumn(draggedId, col.id);
                  }}
                  className={`relative flex h-9 shrink-0 items-center gap-1 px-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 ${divider} ${
                    col.align === "right" ? "justify-end" : filter ? "justify-between" : ""
                  } ${pinnedOffset !== undefined ? "sticky z-20 bg-gray-50" : ""} ${
                    onReorderColumn ? "cursor-grab active:cursor-grabbing" : ""
                  } ${dragOverId === col.id ? "bg-accent-light" : ""}`}
                  style={{ width: col.width, left: pinnedOffset }}
                >
                  <Tooltip text={col.tooltip} placement="bottom" className="min-w-0">
                    <span className="truncate">{col.label}</span>
                  </Tooltip>
                  {filter}
                  {onResizeColumn && (
                    <div
                      role="separator"
                      aria-label={`Resize ${col.label} column`}
                      draggable={false}
                      onMouseDown={(e) => startResize(e, col.id, col.width)}
                      className="absolute -right-1 top-0 z-30 h-full w-2 cursor-col-resize"
                    />
                  )}
                </div>
              );
            })}
            {actionWidth > 0 && <div className="h-9 shrink-0" style={{ width: actionWidth }} />}
          </div>

          {loading ? (
            <div>
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} className="flex border-b border-gray-100" style={{ height: ROW_HEIGHT }}>
                  {selectable && <div className="flex w-10 shrink-0 items-center justify-center" />}
                  {slots.map((slot, si) => (
                    <div
                      key={si}
                      className={`flex shrink-0 items-center px-3 ${si === slots.length - 1 ? "" : groupBoundaries[si] ? GROUP_DIVIDER : THIN_DIVIDER}`}
                      style={{ width: slotWidth(slot) }}
                    >
                      {slot.kind === "column" && <div className="h-3 w-3/4 animate-pulse rounded bg-gray-100" />}
                    </div>
                  ))}
                  {actionWidth > 0 && <div className="shrink-0" style={{ width: actionWidth }} />}
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
                // Fully opaque in every state — `/60` (or any alpha) here would let the
                // scrolling row content bleed through the sticky FAR ID cell underneath it.
                const rowBg = isSelected ? "bg-accent-light" : virtualRow.index % 2 === 1 ? "bg-gray-50" : "bg-white";
                return (
                  <div
                    key={item.asset.farId}
                    data-testid="register-row"
                    data-far-id={item.asset.farId}
                    className={`absolute left-0 top-0 flex w-full border-b border-gray-100 text-sm ${rowBg}`}
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {selectable && (
                      <div className={`sticky left-0 z-10 flex w-10 shrink-0 items-center justify-center ${rowBg}`}>
                        <input
                          type="checkbox"
                          className="accent-accent"
                          checked={isSelected}
                          onChange={() => onToggleRow?.(item.asset.farId)}
                        />
                      </div>
                    )}
                    {slots.map((slot, si) => {
                      const divider = si === slots.length - 1 ? "" : groupBoundaries[si] ? GROUP_DIVIDER : THIN_DIVIDER;
                      if (slot.kind === "collapsed") {
                        return (
                          <div
                            key={`collapsed-cell-${slot.groupId}-${si}`}
                            className={`flex shrink-0 items-center justify-center text-gray-300 ${divider}`}
                            style={{ width: slot.width }}
                          >
                            ⋯
                          </div>
                        );
                      }
                      const col = slot.col;
                      const pinnedOffset = pinnedLeft.get(col.id);
                      return (
                        <div
                          key={col.id}
                          data-testid={`cell-${col.id}`}
                          className={`flex shrink-0 items-center truncate px-3 ${divider} ${
                            col.align === "right" ? "justify-end tabular-nums" : ""
                          } ${pinnedOffset !== undefined ? `sticky z-10 ${rowBg}` : ""}`}
                          style={{ width: col.width, left: pinnedOffset }}
                          title={col.render(item)}
                        >
                          {col.id === "farId" ? (
                            // Visual-only parent/child identification: a child row indents
                            // (parentFarId set) and a parent row gets a link badge
                            // (hasChildren) — no reordering, rows stay in whatever order
                            // the grid's sort already produced.
                            <span
                              className="flex min-w-0 items-center gap-1"
                              style={item.asset.parentFarId ? { paddingLeft: 14 } : undefined}
                            >
                              {item.asset.hasChildren && (
                                <LinkIcon
                                  fontSize={13}
                                  className="shrink-0 text-gray-400"
                                  aria-label="Has child assets"
                                />
                              )}
                              <span className="truncate">{item.asset.farId}</span>
                            </span>
                          ) : (
                            col.render(item)
                          )}
                        </div>
                      );
                    })}
                    {actionWidth > 0 && (
                      <div className="flex shrink-0 items-center justify-center gap-1" style={{ width: actionWidth }}>
                        {onEditAsset && (
                          <button
                            type="button"
                            aria-label={`Edit ${item.asset.farId}`}
                            title="Edit"
                            className="grid h-6 w-6 place-items-center rounded text-gray-400 hover:bg-gray-100 hover:text-accent"
                            onClick={() => onEditAsset(item.asset.farId)}
                          >
                            <EditIcon fontSize={15} />
                          </button>
                        )}
                        {getAssetHref && (
                          <Link
                            to={getAssetHref(item.asset.farId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`View lifecycle for ${item.asset.farId} (opens in a new tab)`}
                            title="View Lifecycle (opens in a new tab)"
                            className="grid h-6 w-6 place-items-center rounded text-gray-400 hover:bg-gray-100 hover:text-accent"
                          >
                            <ViewIcon fontSize={15} />
                          </Link>
                        )}
                        {onDeleteAsset && (
                          <button
                            type="button"
                            aria-label={`${deleteActionLabel} ${item.asset.farId}`}
                            title={deleteActionLabel}
                            className="grid h-6 w-6 place-items-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600"
                            onClick={() => onDeleteAsset(item.asset.farId)}
                          >
                            <DeleteIcon fontSize={15} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );

  const expandButton = (
    <button
      type="button"
      aria-label={expanded ? "Exit full screen" : "Expand table to full screen"}
      title={expanded ? "Exit full screen (Esc)" : "Expand to full screen"}
      onClick={() => setExpanded((e) => !e)}
      className="absolute right-2 top-2 z-30 grid h-7 w-7 place-items-center rounded-md border border-gray-300 bg-white text-gray-500 shadow-sm hover:border-accent hover:text-accent"
    >
      {expanded ? <CollapseExpandIcon fontSize={15} /> : <ExpandIcon fontSize={15} />}
    </button>
  );

  if (expanded) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col bg-white p-4">
        {expandButton}
        {content}
      </div>,
      document.body
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {expandButton}
      {content}
    </div>
  );
}
