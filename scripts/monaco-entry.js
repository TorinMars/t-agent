import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/markdown/register';

window.MonacoEnvironment = {
  getWorkerUrl() {
    return '/vendor/monaco/editor.worker.js';
  },
};

window.monaco = monaco;
