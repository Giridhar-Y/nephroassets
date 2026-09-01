import type { ComponentType, ReactNode } from "react";
import type { FluentIconsProps } from "@fluentui/react-icons";

// The title block every page opens with — was hand-built ~18 times with the same icon +
// h1 + optional subtitle/actions shape (bordered bar for pages with their own scrollable
// body below it, or bare when the page embeds its own padding, e.g. ReportsPage).
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  bordered = true,
  children
}: {
  icon: ComponentType<FluentIconsProps>;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  bordered?: boolean;
  /** Extra content below the title row — e.g. TransfersPage's New/Log tab switcher. */
  children?: ReactNode;
}) {
  return (
    <div className={bordered ? "border-b border-gray-200 bg-white px-6 py-4" : ""}>
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 font-heading text-base font-bold text-ink">
          <Icon fontSize={20} />
          {title}
        </h1>
        {actions}
      </div>
      {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      {children}
    </div>
  );
}
