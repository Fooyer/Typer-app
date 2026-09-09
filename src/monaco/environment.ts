import EditorWorker from "./workers/editor.worker.ts?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
