/** Curb's mark: the page's own sign, where the agent's sphere would say "the agent". While
 * the page waits for something, its orange stroke breathes. */
export function CurbLogo({ size, waiting, className }: { size: number; waiting?: boolean; className?: string }) {
  return (
    <svg
      className={className}
      data-waiting={waiting ? "" : undefined}
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
      <path className="curb-logo-slash" d="M35.2 6 27 42" stroke="#FF6728" />
    </svg>
  );
}

/** Where Curb's code lives. */
export const CURB_REPOSITORY = "https://github.com/Kugelaudio/curb.js";

/** GitHub's mark; the icon set carries no brand marks. */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.13-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.16.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
