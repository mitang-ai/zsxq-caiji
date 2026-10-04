import { brand, markPaths } from "../../shared/brand";

export function BrandMark({
  size = 28,
  animated = false,
}: {
  size?: number;
  animated?: boolean;
}) {
  return (
    <svg
      className={`brand-symbol${animated ? " brand-animated" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden="true"
    >
      <path className="brand-page" d={markPaths.page} />
      <path className="brand-cradle" d={markPaths.cradle} />
    </svg>
  );
}
export function BrandLockup() {
  return (
    <>
      <BrandMark size={34} />
      <strong>{brand.name}</strong>
      <span className="brand-latin">{brand.latin}</span>
    </>
  );
}
