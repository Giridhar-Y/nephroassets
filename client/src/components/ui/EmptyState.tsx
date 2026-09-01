import type { ComponentType, ReactNode } from "react";
import type { FluentIconsProps } from "@fluentui/react-icons";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action
}: {
  icon: ComponentType<FluentIconsProps>;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-16 text-center">
      <Icon fontSize={32} className="mb-2 text-gray-300" />
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="max-w-sm text-sm text-gray-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
