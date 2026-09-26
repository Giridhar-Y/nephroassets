import { useId, useMemo, useRef, useState } from "react";
import type { Assignee, Directory } from "../../api/approvals.js";
import { DismissIcon, PersonIcon, RoleIcon } from "../../lib/icons.js";

// Multi-select of users and roles, shown as chips, with a searchable list. Keyboard:
// type to filter, arrow keys to move, Enter to add, Backspace on an empty search removes
// the last chip. Used by the workflow builder (step assignees) and by reassignment.

export function assigneeLabel(a: Assignee, dir: Directory): string {
  return a.type === "user" ? (dir.users.find((u) => u.id === a.id)?.name ?? `User #${a.id}`) : (dir.roles.find((r) => r.id === a.id)?.name ?? `Role #${a.id}`);
}

export function AssigneeChip({ assignee, label, onRemove }: { assignee: Assignee; label: string; onRemove?: () => void }) {
  const Icon = assignee.type === "role" ? RoleIcon : PersonIcon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-blue/30 bg-brand-blue/10 py-0.5 pl-2 pr-1 text-xs font-medium text-ink [animation:chip-in_150ms_ease-out]">
      <Icon fontSize={13} className="text-brand-blue" aria-hidden />
      <span className="sr-only">{assignee.type === "role" ? "Role:" : "User:"}</span>
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="grid h-4 w-4 place-items-center rounded-full text-gray-500 hover:bg-white hover:text-accent"
        >
          <DismissIcon fontSize={10} />
        </button>
      )}
    </span>
  );
}

export function AssigneePicker({
  value,
  onChange,
  directory,
  placeholder = "Add people or roles…",
  roleOnly = false
}: {
  value: Assignee[];
  onChange: (next: Assignee[]) => void;
  directory: Directory;
  placeholder?: string;
  /** Initiator pickers take roles only. */
  roleOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const taken = new Set(value.map((a) => `${a.type}:${a.id}`));
    const roles = directory.roles
      .filter((r) => r.active && !taken.has(`role:${r.id}`) && r.name.toLowerCase().includes(q))
      .map((r) => ({ assignee: { type: "role" as const, id: r.id }, label: r.name, hint: "Role" }));
    const users = roleOnly
      ? []
      : directory.users
          .filter((u) => u.active && !taken.has(`user:${u.id}`) && (u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)))
          .map((u) => ({ assignee: { type: "user" as const, id: u.id }, label: u.name, hint: u.role }));
    return [...roles, ...users].slice(0, 12);
  }, [query, value, directory, roleOnly]);

  function add(a: Assignee) {
    onChange([...value, a]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }

  return (
    <div className="relative">
      <div
        className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2 py-1.5 focus-within:border-brand-blue focus-within:ring-1 focus-within:ring-brand-blue"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((a, i) => (
          <AssigneeChip key={`${a.type}:${a.id}`} assignee={a} label={assigneeLabel(a, directory)} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={placeholder}
          value={query}
          placeholder={value.length ? "" : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && open && options[active]) {
              e.preventDefault();
              add(options[active]!.assignee);
            } else if (e.key === "Backspace" && !query && value.length) {
              onChange(value.slice(0, -1));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className="min-w-[120px] flex-1 border-0 bg-transparent p-0.5 text-sm text-ink placeholder:text-gray-400 focus:outline-none focus:ring-0"
        />
      </div>
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="animate-panel-in absolute left-0 right-0 z-40 mt-1 max-h-60 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {options.map((o, i) => {
            const Icon = o.assignee.type === "role" ? RoleIcon : PersonIcon;
            return (
              <li key={`${o.assignee.type}:${o.assignee.id}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(o.assignee)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === active ? "bg-brand-blue/10" : ""}`}
                >
                  <Icon fontSize={15} className="text-brand-blue" aria-hidden />
                  <span className="flex-1 text-ink">{o.label}</span>
                  <span className="text-xs text-gray-500">{o.hint}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
