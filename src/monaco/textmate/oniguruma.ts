import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
import type { IOnigLib } from "vscode-textmate";
// Relative path into node_modules: this bundler (rolldown-vite) cannot resolve
// bare package-subpath specifiers through the `?url`/`?worker` asset pipeline,
// see src/monaco/workers/editor.worker.ts for the same workaround.
import onigWasmUrl from "../../../node_modules/vscode-oniguruma/release/onig.wasm?url";

let onigLibPromise: Promise<IOnigLib> | null = null;

export function getOnigLib(): Promise<IOnigLib> {
  if (!onigLibPromise) {
    onigLibPromise = fetch(onigWasmUrl)
      .then((response) => response.arrayBuffer())
      .then((buffer) => loadWASM(buffer))
      .then(() => ({
        createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
        createOnigString: (value: string) => new OnigString(value),
      }));
  }
  return onigLibPromise;
}
