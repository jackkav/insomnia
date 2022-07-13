import orderedJSON from 'json-order';
import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

import {  JSON_ORDER_PREFIX, JSON_ORDER_SEPARATOR } from '../../../common/constants';
import { NUNJUCKS_TEMPLATE_GLOBAL_PROPERTY_NAME } from '../../../templating';
import { CodeEditor,  UnconnectedCodeEditor } from '../codemirror/code-editor';

// NeDB field names cannot begin with '$' or contain a period '.'
// Docs: https://github.com/DeNA/nedb#inserting-documents
const INVALID_NEDB_KEY_REGEX = /^\$|\./;

export const ensureKeyIsValid = (key: string, isRoot: boolean): string | null => {
  if (key.match(INVALID_NEDB_KEY_REGEX)) {
    return `"${key}" cannot begin with '$' or contain a '.'`;
  }

  if (key === NUNJUCKS_TEMPLATE_GLOBAL_PROPERTY_NAME && isRoot) {
    return `"${NUNJUCKS_TEMPLATE_GLOBAL_PROPERTY_NAME}" is a reserved key`;
  }

  return null;
};

/**
 * Recursively check nested keys in and immediately return when an invalid key found
 */
export function checkNestedKeys(obj: Record<string, any>, isRoot = true): string | null {
  for (const key in obj) {
    let result: string | null = null;

    // Check current key
    result = ensureKeyIsValid(key, isRoot);

    // Exit if necessary
    if (result) {
      return result;
    }

    // Check nested keys
    if (typeof obj[key] === 'object') {
      result = checkNestedKeys(obj[key], false);
    }

    // Exit if necessary
    if (result) {
      return result;
    }
  }

  return null;
}

export interface EnvironmentInfo {
  object: Record<string, any>;
  propertyOrder: Record<string, any> | null;
}

interface Props {
  environmentInfo: EnvironmentInfo;
  didChange: (...args: any[]) => any;
}

// There was existing logic to also handle warnings, but it was removed in PR#2601 as there were no more warnings
// to show. If warnings need to be added again, review git history to revert that particular change.
interface EnvironmentEditorHandle {
  isValid: () => boolean;
  getValue: () => EnvironmentInfo | null;
}
export const EnvironmentEditor = forwardRef<EnvironmentEditorHandle, Props>(({ environmentInfo, didChange, ...rest }, ref) => {
  const _editor = useRef<UnconnectedCodeEditor>(null);
  const [error, setError] = useState<string | null>(null);

  const getValue = useCallback((): EnvironmentInfo | null => {
    if (_editor.current) {
      const data = orderedJSON.parse(
        _editor.current.getValue(),
        JSON_ORDER_PREFIX,
        JSON_ORDER_SEPARATOR,
      );
      return {
        object: data.object,
        propertyOrder: data.map || null,
      };
    }
    return null;
  }, []);

  useImperativeHandle(ref, () => ({ isValid:() => !error, getValue }), [error, getValue]);

  const onChange = useCallback(() => {
    let value: EnvironmentInfo | null = null;
    // Check for JSON parse errors
    try {
      value = getValue();
    } catch (err) {
      setError(err.message);
      didChange();
      return;
    }
    // Check for invalid key names
    if (value && value.object) {
      // Check root and nested properties
      const err = checkNestedKeys(value.object);
      if (err) {
        setError(err);
        didChange();
        return;
      }
    }
    // Call this last in case component unmounted
    didChange();
  }, [didChange, getValue]);

  const defaultValue = orderedJSON.stringify(
    environmentInfo.object,
    environmentInfo.propertyOrder || null,
    JSON_ORDER_SEPARATOR,
  );
  return (
    <div className="environment-editor">
      <CodeEditor
        ref={_editor}
        autoPrettify
        enableNunjucks
        onChange={onChange}
        defaultValue={defaultValue}
        mode="application/json"
        {...rest}
      />
      {error && <p className="notice error margin">{error}</p>}
    </div>
  );
});
EnvironmentEditor.displayName = 'EnvironmentEditor';
