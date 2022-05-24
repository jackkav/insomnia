import React, { useRef, useState } from 'react';

import { KeydownBinder } from '../keydown-binder';

export const shouldSave = (oldValue, newValue, preventBlank = false) => {
  // Should not save if length = 0 and we want to prevent blank
  if (preventBlank && !newValue.length) {
    return false;
  }

  // Should not save if old value and new value is the same
  if (oldValue === newValue) {
    return false;
  }

  // Should save
  return true;
};

interface Props {
  onSubmit: (value?: string) => void;
  value: string;
  fallbackValue?: string;
  blankValue?: string;
  renderReadView?: Function;
  singleClick?: boolean;
  onEditStart?: Function;
  className?: string;
  preventBlank?: boolean;
}

export const Editable = ({
  value,
  fallbackValue,
  // Q: when is this needed?
  blankValue,
  singleClick,
  onEditStart,
  preventBlank,
  className,
  onSubmit,
  renderReadView,
  ...extra
}: Props) => {
  const [isEditing, setEdit] = useState(false);
  const inputRef = useRef(null);
  const initialValue = value || fallbackValue;

  const _handleEditStart = () => {
    setEdit(true);

    setTimeout(() => {
      inputRef?.current?.focus();
      inputRef?.current?.select();
    });

    // Q: Only used for drag and drop in one parent component use case, how to improve?
    if (onEditStart) {
      onEditStart();
    }
  };

  const _handleEditEnd = () => {
    // Q: can preventBlank be defaulted to true?
    if (shouldSave(value, inputRef?.current?.value.trim(), preventBlank)) {
      // Don't run onSubmit for values that haven't been changed
      onSubmit(inputRef?.current?.value.trim());
    }

    // WARN: can we not do this?
    // This timeout prevents the UI from showing the old value after submit.
    // It should give the UI enough time to redraw the new value.
    setTimeout(() => setEdit(false), 100);
  };

  if (isEditing) {
    const onKeyDown = (event: KeyboardEvent) => {
      const isEnter = event.keyCode === 13;
      const isEscape = event.keyCode === 27;
      if (isEnter) {
        _handleEditEnd();
        return;
      }
      if (isEscape) {
        // Prevent bubbling to modals and other escape listeners.
        event.stopPropagation();

        if (inputRef.current) {
          // Set the input to the original value
          inputRef.current.value = value;
        }
      }
    };
    return (
      // KeydownBinder must be used here to properly stop propagation
      // from reaching other scoped KeydownBinders
      <KeydownBinder onKeydown={onKeyDown} scoped>
        <input
          {...extra}
          className={`editable< ${className || ''}`}
          type="text"
          ref={inputRef}
          defaultValue={initialValue}
          onBlur={_handleEditEnd}
        />
      </KeydownBinder>
    );
  } else {
    const readViewProps = {
      className: `editable ${className} ${!initialValue && 'empty'}`,
      title: singleClick ? 'Click to edit' : 'Double click to edit',
      onClick: () => singleClick && _handleEditStart(),
      onDoubleClick: _handleEditStart,
      ...extra,
    };

    if (renderReadView) {
      return renderReadView(initialValue, readViewProps);
    } else {
      return <span {...readViewProps}>{initialValue || blankValue}</span>;
    }
  }
};
