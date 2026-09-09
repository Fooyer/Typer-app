/** Inline version of public/favicon.svg — same shape, but colored via --logo-color/--logo-color-2
 * (set in themes/appearance.ts) instead of a fixed gradient, so it follows the selected theme's
 * accent (or the user's chosen accent override, see SettingsModal) instead of always being purple. */
function AppLogo() {
  return (
    <svg className="app-icon" viewBox="0 0 256 256" aria-hidden="true">
      <defs>
        <linearGradient
          id="app-logo-bg"
          x1="0"
          y1="0"
          x2="256"
          y2="256"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-color)" />
          <stop offset="1" stopColor="var(--logo-color-2)" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="52" fill="url(#app-logo-bg)" />
      <path
        d="M62 96 L100 128 L62 160"
        fill="none"
        stroke="#ffffff"
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M118 168 L182 168"
        fill="none"
        stroke="#ffffff"
        strokeWidth="18"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default AppLogo;
