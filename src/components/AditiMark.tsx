/**
 * Aditi's mark: a sun with eight short rays — Aditi is the mother of the
 * Adityas, the sun deities, and her name means "boundless". Drawn in
 * currentColor so it sits on any filled badge; legible down to 12px.
 */
export function AditiMark({ className = "size-4" }: { className?: string }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <circle cx="12" cy="12" r="4.6" fill="currentColor" />
      {rays.map((deg) => (
        <line
          key={deg}
          x1="12"
          y1="2.6"
          x2="12"
          y2={deg % 90 === 0 ? "5.4" : "4.9"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
    </svg>
  );
}
