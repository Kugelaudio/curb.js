/** Curb's mark: the page's own sign, where the agent's sphere would say "the agent". */
export function CurbLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      strokeWidth="4.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Curb"
    >
      <path d="M13 11 3.5 24 13 37M23.2 17.5 20.2 30.5M43.5 15.5 39.6 32.5" stroke="currentColor" />
      <path d="M35.2 6 27 42" stroke="#FF6728" />
    </svg>
  );
}
