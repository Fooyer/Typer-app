import { marked } from "marked";
import DOMPurify from "dompurify";

// `breaks: true` treats a single newline as `<br>` — the agent's prose often doesn't bother with
// CommonMark's blank-line-between-paragraphs rule, and without this a normal chat-style reply
// collapses onto one run-on line instead of showing the line breaks it was written with.
marked.setOptions({ gfm: true, breaks: true });

// Runs on every sanitize call (module-level, so it only needs registering once) — turns links the
// agent's markdown produces into external navigations instead of same-window ones, which is what
// main.ts's setWindowOpenHandler is already set up to hand off to the OS browser via
// shell.openExternal.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Renders agent markdown to sanitized HTML for `dangerouslySetInnerHTML` — the agent's output is
 * an LLM's response to whatever it just read off the server, so it's treated as untrusted input
 * (DOMPurify strips script tags, event handler attributes, etc.) even though this is a desktop app
 * and not a public website. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
}
