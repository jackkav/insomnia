import classnames from 'classnames';
import React, { forwardRef, Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

import { CodeEditor, CodeEditorOnChange, UnconnectedCodeEditor } from './code-editor';
const MODE_INPUT = 'input';
const MODE_EDITOR = 'editor';
const TYPE_TEXT = 'text';
const NUNJUCKS_REGEX = /({%|%}|{{|}})/;

interface Props {
  defaultValue: string;
  id?: string;
  type?: string;
  mode?: string;
  onBlur?: (event: FocusEvent | React.FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent | React.KeyboardEvent, value?: any) => void;
  onFocus?: (event: FocusEvent | React.FocusEvent) => void;
  onChange?: CodeEditorOnChange;
  onPaste?: (event: ClipboardEvent) => void;
  getAutocompleteConstants?: () => string[] | PromiseLike<string[]>;
  placeholder?: string;
  className?: string;
  forceEditor?: boolean;
  forceInput?: boolean;
  readOnly?: boolean;
}

export interface OneLineEditorHandle {
  focus: () => void;
  selectAll: () => void;
  getValue: () => string | undefined;
  getSelectionStart: () => number | null | undefined;
  getSelectionEnd: () => number | null | undefined;
}
export const OneLineEditorFC = forwardRef<OneLineEditorHandle, Props>((props, ref) => {
  const {
    id,
    defaultValue,
    className,
    onChange,
    placeholder,
    onPaste,
    getAutocompleteConstants,
    mode: syntaxMode,
    type: originalType,
  } = props;
  let defaultToInputOrEditor: 'input' | 'editor' = MODE_INPUT;

  if (props.forceInput) {
    defaultToInputOrEditor = MODE_INPUT;
  } else if (props.forceEditor) {
    defaultToInputOrEditor = MODE_EDITOR;
  } else if (_mayContainNunjucks(props.defaultValue)) {
    defaultToInputOrEditor = MODE_EDITOR;
  }
  const [mode, setMode] = useState(defaultToInputOrEditor);
  const editorRef = useRef<UnconnectedCodeEditor>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const getValue = useCallback(() => {
    if (mode === MODE_EDITOR) {
      return editorRef.current?.getValue();
    } else {
      return inputRef.current?.value;
    }
  }, [mode]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
    },
    selectAll: () => {
      if (mode === MODE_EDITOR) {
        editorRef.current?.selectAll();
      } else {
        inputRef.current?.select();
      }
    },
    getSelectionStart: () => {
      if (editorRef.current) {
        return editorRef.current?.getSelectionStart();
      } else {
        console.warn('Tried to get selection start of one-line-editor when <input>');
        return inputRef.current?.value.length;
      }
    },
    getSelectionEnd: () => {
      if (editorRef.current) {
        return editorRef.current?.getSelectionEnd();
      } else {
        console.warn('Tried to get selection end of one-line-editor when <input>');
        return inputRef.current?.value.length;
      }
    },
    getValue,
  }), [getValue, mode]);
  useEffect(() => {
    document.body.addEventListener('mousedown', _handleDocumentMousedown);
    return () => document.body.removeEventListener('mousedown', _handleDocumentMousedown);
  }, []);
  function _handleDocumentMousedown(event: MouseEvent) {
    if (!editorRef.current) {
      return;
    }

    // Clear the selection if mousedown happens outside the input so we act like
    // a regular <input>
    // NOTE: Must be "mousedown", not "click" because "click" triggers on selection drags
    const node = ReactDOM.findDOMNode(editorRef.current);
    // @ts-expect-error -- TSCONVERSION
    const clickWasOutsideOfComponent = !node.contains(event.target);

    if (clickWasOutsideOfComponent) {
      editorRef.current?.clearSelection();
    }
  }

  function _handleInputDragEnter() {
    _convertToEditorPreserveFocus();
  }

  function _handleInputMouseEnter() {
    // Convert to editor when user hovers mouse over input

    /*
     * NOTE: we're doing it in a timeout because we don't want to convert if the
     * mouse goes in an out right away.
     */
    // _mouseEnterTimeout = setTimeout(_convertToEditorPreserveFocus, 100);
  }

  function _handleInputMouseLeave() {
    // if (_mouseEnterTimeout !== null) {
    //   clearTimeout(_mouseEnterTimeout);
    // }
  }

  function _handleEditorMouseLeave() {
    _convertToInputIfNotFocused();
  }

  function _handleEditorFocus(event: FocusEvent) {
    // TODO: unclear why this is missing in TypeScript DOM.
    const focusedFromTabEvent = !!(event as any).sourceCapabilities;

    if (focusedFromTabEvent) {
      editorRef.current?.focusEnd();
    }

    if (!editorRef.current) {
      console.warn('Tried to focus editor when it was not mounted');
      return;
    }

    // Set focused state
    editorRef.current?.setAttribute('data-focused', 'on');

    props.onFocus?.(event);
  }

  function _handleInputFocus(event: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement, Element>) {
    // If we're focusing the whole thing, blur the input. This happens when
    // the user tabs to the field.
    const start = inputRef.current?.selectionStart;

    const end = inputRef.current?.selectionEnd;

    const focusedFromTabEvent = start === 0 && end === event.target.value.length;

    if (focusedFromTabEvent) {
      inputRef.current?.focus();

      // Also convert to editor if we tabbed to it. Just in case the user
      // needs an editor
      _convertToEditorPreserveFocus();
    }

    // Set focused state
    inputRef.current?.setAttribute('data-focused', 'on');

    // Also call the regular callback
    props.onFocus?.(event);
  }

  function _handleInputChange(value: string) {
    _convertToEditorPreserveFocus();

    props.onChange?.(value);
  }

  function _handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (props.onKeyDown) {
      props.onKeyDown(event, event.currentTarget.value);
    }
  }

  function _handleInputBlur(event: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>) {
    // Set focused state
    inputRef.current?.removeAttribute('data-focused');

    props.onBlur?.(event);
  }

  function _handleEditorBlur(event: FocusEvent) {
    // Editor was already removed from the DOM, so do nothing
    if (!editorRef.current) {
      return;
    }

    // Set focused state
    editorRef.current?.removeAttribute('data-focused');

    if (!props.forceEditor) {
      // Convert back to input sometime in the future.
      // NOTE: this was originally added because the input would disappear if
      // the user tabbed away very shortly after typing, but it's actually a pretty
      // good feature.
      setTimeout(() => {
        _convertToInputIfNotFocused();
      }, 2000);
    }

    props.onBlur?.(event);
  }

  // @TODO Refactor this event handler. The way we search for a parent form node is not stable.
  function _handleKeyDown(event: KeyboardEvent) {
    // submit form if needed
    if (event.keyCode === 13) {
      // TODO: This can be NULL, or not an HTMLElement.
      let node = event.target as HTMLElement;

      for (let i = 0; i < 20 && node; i++) {
        if (node.tagName === 'FORM') {
          node.dispatchEvent(new window.Event('submit'));
          event.preventDefault();
          event.stopPropagation();
          break;
        }

        // TODO: This can be NULL.
        node = node.parentNode as HTMLElement;
      }
    }

    props.onKeyDown?.(event, getValue());
  }

  function _convertToEditorPreserveFocus() {
    if (mode !== MODE_INPUT || props.forceInput) {
      return;
    }

    if (!inputRef.current) {
      return;
    }

    if (document.activeElement === inputRef.current) {
      const start = inputRef.current?.selectionStart;
      const end = inputRef.current?.selectionEnd;
      if (start === null || end === null) {
        return;
      }

      // Wait for the editor to swap and restore cursor position
      const check = () => {
        if (editorRef.current) {
          editorRef.current?.focus();

          editorRef.current?.setSelection(start, end, 0, 0);
        } else {
          setTimeout(check, 40);
        }
      };

      // Tell the component to show the editor
      setTimeout(check);
    }
    setMode(MODE_EDITOR);
  }

  function _convertToInputIfNotFocused() {
    if (mode === MODE_INPUT || props.forceEditor) {
      return;
    }

    if (!editorRef.current || editorRef.current?.hasFocus()) {
      return;
    }

    if (_mayContainNunjucks(getValue() || '')) {
      return;
    }
    setMode(MODE_INPUT);
  }
  function _mayContainNunjucks(text: string) {
    // Not sure, but sometimes this isn't a string
    if (typeof text !== 'string') {
      return false;
    }

    // Does the string contain Nunjucks tags?
    return !!text.match(NUNJUCKS_REGEX);
  }

  const type = originalType || TYPE_TEXT;
  const showEditor = mode === MODE_EDITOR;

  if (showEditor) {
    return (
      <Fragment>
        <CodeEditor
          ref={editorRef}
          defaultTabBehavior
          hideLineNumbers
          hideScrollbars
          noMatchBrackets
          noStyleActiveLine
          noLint
          singleLine
          ignoreEditorFontSettings
          enableNunjucks
          autoCloseBrackets={false}
          tabIndex={0}
          id={id}
          type={type}
          mode={syntaxMode}
          placeholder={placeholder}
          onPaste={onPaste}
          onBlur={_handleEditorBlur}
          onKeyDown={_handleKeyDown}
          onFocus={_handleEditorFocus}
          onMouseLeave={_handleEditorMouseLeave}
          onChange={onChange}
          getAutocompleteConstants={getAutocompleteConstants}
          className={classnames('editor--single-line', className)}
          defaultValue={defaultValue}
        />
      </Fragment>
    );
  } else {
    return (
      <input
        ref={inputRef}
        id={id}
        type={type}
        className={className}
        style={{
          width: '100%',
        }}
        placeholder={placeholder}
        defaultValue={defaultValue}
        onBlur={_handleInputBlur}
        onChange={event => _handleInputChange(event.target.value)}
        onMouseEnter={_handleInputMouseEnter}
        onMouseLeave={_handleInputMouseLeave}
        onDragEnter={_handleInputDragEnter}
        onFocus={_handleInputFocus}
        onKeyDown={_handleInputKeyDown}
      />
    );
  }
});
OneLineEditorFC.displayName = 'OneLineEditorFC';
