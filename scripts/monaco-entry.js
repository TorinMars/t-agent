import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/markdown/register';

import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/features/json/register';

window.MonacoEnvironment = {
  getWorkerUrl(moduleId, label) {
    if (label === 'json') return '/vendor/monaco/json.worker.js';
    return '/vendor/monaco/editor.worker.js';
  },
};

window.monaco = monaco;
