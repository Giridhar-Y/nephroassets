// Brand mark: an "N"/"M" monogram with an isometric cube inlaid at its center — the
// cube reads as the app's subject (a Fixed Asset Register), the letterform as its name.
// Solid #18181B (the app's `ink` token). Traced (via OpenCV contour extraction, not
// hand-drawn) from the source artwork at client/src/assets/logo.png, so the 5 polygons
// below are exact — don't hand-edit the coordinates, re-trace from the source if the
// mark ever changes.
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 819 819" className={className} aria-hidden="true">
      <polygon points="1,0 0,818 163,818 163,258 312,168 158,1" fill="#18181B" />
      <polygon points="656,0 656,560 507,650 658,819 819,819 819,1" fill="#18181B" />
      <polygon points="408,159 221,271 410,383 598,271" fill="#18181B" />
      <polygon points="205,309 205,538 388,647 388,418" fill="#18181B" />
      <polygon points="614,309 431,418 431,647 614,537" fill="#18181B" />
    </svg>
  );
}
