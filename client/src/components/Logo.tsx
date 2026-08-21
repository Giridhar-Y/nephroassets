// Brand mark: an "N" monogram with an isometric cube inlaid at its center — the cube
// reads as the app's subject (a Fixed Asset Register), the N as its name. Solid #18181B
// (the app's `ink` token) to match the sidebar wordmark it sits next to.
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true">
      <rect x="10" y="14" width="17" height="72" fill="#18181B" />
      <rect x="73" y="14" width="17" height="72" fill="#18181B" />
      <polygon points="27,14 44,14 90,74 90,86 73,86 27,26" fill="#18181B" />
      {/* White halo separates the cube from the diagonal band behind it */}
      <polygon points="50,38 70,48 70,68 50,78 30,68 30,48" fill="#ffffff" />
      <polygon points="50,40 66,48 50,56 34,48" fill="#18181B" stroke="#ffffff" strokeWidth="1.6" strokeLinejoin="round" />
      <polygon points="34,48 50,56 50,72 34,64" fill="#18181B" stroke="#ffffff" strokeWidth="1.6" strokeLinejoin="round" />
      <polygon points="50,56 66,48 66,64 50,72" fill="#18181B" stroke="#ffffff" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
