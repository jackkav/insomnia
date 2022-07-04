import Editor, { EditorProps } from '@monaco-editor/react';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import React, { FC } from 'react';

globalThis.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') {
      return new jsonWorker();
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new cssWorker();
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new htmlWorker();
    }
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

loader.init().then(console.log);

export type MonacoLanguage = 'json' | 'html' | 'text';

export interface MonacoProps extends EditorProps {
  language: MonacoLanguage;
}

export const Monaco: FC<MonacoProps> = ({ language, ...rest }) => {
  const handleEditorDidMount: EditorProps['onMount'] = (editor, monaco) => {
    monaco.languages.registerCompletionItemProvider('*', {
      provideCompletionItems: (model, position) => {
        return {
          suggestions: ['list', 'of', 'crap'].map(x => ({
            label: x,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'fk ${1:table_name}.${2:field}',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Foreign key to table field statement',
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
          })),
        };
      },
    });
  };
  return (
    <Editor
      theme="vs-dark"
      language={language}
      onMount={handleEditorDidMount}
      {...rest}
    />
  );
};
