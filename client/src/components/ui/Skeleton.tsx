export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-gray-100 ${className}`} />;
}

// A generic stand-in for a data table while its first fetch is in flight — matches the
// header + striped-row shape most pages already use instead of a bare spinner.
export function TableSkeleton({ rows = 8, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="w-full">
      <div className="flex gap-4 border-b border-gray-200 px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-gray-100 px-4 py-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
