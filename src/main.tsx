import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./platform/electronApiShim";
import "./monaco/environment.ts";
import { applyAppChrome } from "./themes/appearance";
import { BUILTIN_THEMES } from "./themes/registry";
import App from "./App.tsx";

// Applied synchronously, before the first paint, so the app shell never flashes unstyled.
applyAppChrome(BUILTIN_THEMES[0]);

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Double rAF: the first fires once the browser is ready to paint the frame React just committed,
// the second confirms that frame actually made it to screen — removing the loading screen any
// earlier risks a one-frame gap back to the (dark, so not a white flash, but still a visible pop)
// html/body background before the real app shell is there to replace it.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.getElementById("app-loading")?.remove();
  });
});
