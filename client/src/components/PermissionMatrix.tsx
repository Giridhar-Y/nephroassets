import { useState } from "react";
import { MODULE_LABELS, MODULES, PERMISSION_REGISTRY, actionLabel, type Module } from "../lib/permissions.js";
import { ChevronDownIcon } from "../lib/icons.js";

/** Collapsible module-group checkbox matrix over the full PERMISSION_REGISTRY — every
 *  (module, action) pair in the app, independent of whose grants they represent. Shared
 *  by AdminPage.tsx's per-user Permissions panel and MastersPage.tsx's Roles tab (a
 *  role's own template is the same shape as a user's actual grants, just applied at a
 *  different time — see auth/permissions.ts's comment on seedPermissionsFromRole), so
 *  the two can never visually or behaviorally drift apart. Fully controlled: `granted`
 *  is the current checked set, `onChange` receives the complete next set on every
 *  toggle — callers own persistence (Save button, API call), this component only ever
 *  computes the next desired state. */
export function PermissionMatrix({
  granted,
  onChange,
  loading
}: {
  granted: Set<string>;
  onChange: (next: Set<string>) => void;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<Module>>(new Set());

  function toggle(module: Module, action: string) {
    const key = `${module}:${action}`;
    const next = new Set(granted);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  function toggleModule(module: Module, allOn: boolean) {
    const next = new Set(granted);
    for (const action of PERMISSION_REGISTRY[module]) {
      const key = `${module}:${action}`;
      if (allOn) next.delete(key);
      else next.add(key);
    }
    onChange(next);
  }

  function toggleExpanded(module: Module) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-gray-100" />
        ))}
      </div>
    );
  }

  return (
    <>
      {MODULES.map((module) => {
        const actions = PERMISSION_REGISTRY[module] as readonly string[];
        const grantedCount = actions.filter((a) => granted.has(`${module}:${a}`)).length;
        const allOn = grantedCount === actions.length;
        const isOpen = expanded.has(module);
        return (
          <div key={module} className="border-b border-gray-100 py-2">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 py-1.5 text-left"
              onClick={() => toggleExpanded(module)}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <ChevronDownIcon fontSize={14} className={isOpen ? "" : "-rotate-90"} />
                {MODULE_LABELS[module]}
              </span>
              <span className="text-xs text-gray-400">
                {grantedCount}/{actions.length}
              </span>
            </button>
            {isOpen && (
              <div className="ml-5 mt-1 space-y-1.5">
                <label className="flex items-center gap-2 text-xs font-medium text-accent">
                  <input type="checkbox" checked={allOn} onChange={() => toggleModule(module, allOn)} />
                  Select all
                </label>
                {actions.map((action) => (
                  <label key={action} className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={granted.has(`${module}:${action}`)} onChange={() => toggle(module, action)} />
                    {actionLabel(action)}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
