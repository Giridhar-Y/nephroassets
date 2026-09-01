import wordmarkUrl from "../assets/brand/logo_primary.svg";
import symbolUrl from "../assets/brand/logo_symbol.svg";

// Official NephroPlus marks (nephroplus-brand skill, assets/logos/logo_primary.svg) — the
// wordmark, and a symbol-only crop of the same source paths for small/collapsed contexts
// (skill rule: symbol alone only below ~8mm). Never recolor/redraw — light backgrounds only,
// per the skill's logo-quirks note that this asset bundle has no usable reversed/white mark.
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return <img src={wordmarkUrl} alt="NephroPlus" height={size} className={className} style={{ height: size, width: "auto" }} />;
}

export function LogoSymbol({ size = 24, className }: { size?: number; className?: string }) {
  return <img src={symbolUrl} alt="NephroPlus" height={size} className={className} style={{ height: size, width: "auto" }} />;
}

// The app's own typed name (not the NephroPlus logo above) — split two-tone the same
// way the official logo splits "nephro"/"plus": Deep Blue then Crimson.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={className}>
      <span className="text-ink">Nephro</span>
      <span className="text-accent">Assets</span>
    </span>
  );
}
