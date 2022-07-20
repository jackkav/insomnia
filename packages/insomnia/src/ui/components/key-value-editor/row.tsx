// eslint-disable-next-line filenames/match-exported
import classnames from 'classnames';
import React, { FC, forwardRef, ForwardRefRenderFunction, useImperativeHandle, useRef, useState } from 'react';
import { ConnectDragPreview, ConnectDragSource, ConnectDropTarget, DragSource, DropTarget, DropTargetMonitor } from 'react-dnd';
import ReactDOM from 'react-dom';

import { describeByteSize } from '../../../common/misc';
import { useNunjucksEnabled } from '../../context/nunjucks/nunjucks-enabled-context';
import { Button } from '../base/button';
import { Dropdown } from '../base/dropdown/dropdown';
import { DropdownButton } from '../base/dropdown/dropdown-button';
import { DropdownItem } from '../base/dropdown/dropdown-item';
import { FileInputButton } from '../base/file-input-button';
import { PromptButton } from '../base/prompt-button';
import { OneLineEditor } from '../codemirror/one-line-editor';
import { CodePromptModal } from '../modals/code-prompt-modal';
import { showModal } from '../modals/index';

export interface Pair {
  id: string;
  name: string;
  value: string;
  description: string;
  fileName?: string;
  type?: string;
  disabled?: boolean;
  multiline?: boolean | string;
}

export type AutocompleteHandler = (pair: Pair) => string[] | PromiseLike<string[]>;

type DragDirection = 0 | 1 | -1;

interface Props {
  onChange: (pair: Pair) => void;
  onDelete: (pair: Pair) => void;
  onFocusName: (pair: Pair, event: FocusEvent | React.FocusEvent<Element, Element>) => void;
  onFocusValue: (pair: Pair, event: FocusEvent | React.FocusEvent<Element, Element>) => void;
  onFocusDescription: (pair: Pair, event: FocusEvent | React.FocusEvent<Element, Element>) => void;
  displayDescription: boolean;
  index: number;
  pair: Pair;
  readOnly?: boolean;
  onMove?: (pairToMove: Pair, pairToTarget: Pair, targetOffset: 1 | -1) => void;
  onKeyDown?: (pair: Pair, event: KeyboardEvent | React.KeyboardEvent<Element>, value?: any) => void;
  onBlurName?: (pair: Pair, event: FocusEvent | React.FocusEvent<Element, Element>) => void;
  onBlurValue?: (pair: Pair, event: FocusEvent | React.FocusEvent<Element, Element>) => void;
  onBlurDescription?: (pair: Pair, event: FocusEvent | React.FocusEvent<Element, Element>) => void;
  enableNunjucks?: boolean;
  handleGetAutocompleteNameConstants?: AutocompleteHandler;
  handleGetAutocompleteValueConstants?: AutocompleteHandler;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  descriptionPlaceholder?: string;
  valueInputType?: string;
  forceInput?: boolean;
  allowMultiline?: boolean;
  allowFile?: boolean;
  sortable?: boolean;
  noDelete?: boolean;
  noDropZone?: boolean;
  hideButtons?: boolean;
  className?: string;
  renderLeftIcon?: Function;
  // For drag-n-drop
  connectDragSource?: ConnectDragSource;
  connectDragPreview?: ConnectDragPreview;
  connectDropTarget?: ConnectDropTarget;
  isDragging?: boolean;
  isDraggingOver?: boolean;
}

interface KeyValueEditorRowInternalHandle {
  focusNameEnd: () => void;
  focusValueEnd: () => void;
  focusDescriptionEnd: () => void;
  setDragDirection: (d: DragDirection) => void;
}

const KeyValueEditorRowInternal: FC<Props> = forwardRef<KeyValueEditorRowInternalHandle, Props>((props, ref) => {
  const nameInputRef = useRef<OneLineEditor>(null);
  const valueInputRef = useRef<OneLineEditor>(null);
  const descriptionInputRef = useRef<OneLineEditor>(null);
  const [dragDirection, setDragDirection] = useState<DragDirection>(0);
  useImperativeHandle(ref, () => ({
    focusNameEnd: () => {
      if (nameInputRef.current) {
        nameInputRef.current.focusEnd();
      }
    },
    focusValueEnd: () => {
      if (valueInputRef.current) {
        valueInputRef.current?.focusEnd();
      }
    },
    focusDescriptionEnd: () => {
      if (descriptionInputRef.current) {
        descriptionInputRef.current?.focusEnd();
      }
    },
    setDragDirection,
  }), [setDragDirection]);

  function _sendChange(patch: Partial<Pair>) {
    const pair = Object.assign({}, props.pair, patch);
    props.onChange?.(pair);
  }

  function _handleValuePaste(event: ClipboardEvent) {
    if (!props.allowMultiline) {
      return;
    }

    const value = event.clipboardData?.getData('text/plain');

    if (value?.includes('\n')) {
      event.preventDefault();

      // Insert the pasted text into the current selection.
      // Unfortunately, this is the easiest way to do this.
      const currentValue = valueInputRef.current?.getValue() || '';

      const prefix = currentValue.slice(0, valueInputRef.current?.getSelectionStart() || 0);
      const suffix = currentValue.slice(valueInputRef.current?.getSelectionEnd() || 0);
      const finalValue = `${prefix}${value}${suffix}`;

      // Update type and value
      _handleTypeChange({
        type: 'text',
        multiline: 'text/plain',
      });

      _handleValueChange(finalValue);
    }
  }

  function _handleNameChange(name: string) {
    _sendChange({ name });
  }

  function _handleValueChange(value: string) {
    _sendChange({ value });
  }

  function _handleFileNameChange(fileName: string) {
    _sendChange({ fileName });
  }

  function _handleDescriptionChange(description: string) {
    _sendChange({ description });
  }

  function _handleDisableChange(_event: React.MouseEvent, disabled?: boolean) {
    _sendChange({ disabled });
  }

  function _handleTypeChange(def: Partial<Pair>) {
    // Remove newlines if converting to text
    // WARNING: props should never be overwritten!
    let value = props.pair.value || '';

    if (def.type === 'text' && !def.multiline && value.includes('\n')) {
      value = value.replace(/\n/g, '');
    }

    _sendChange({
      type: def.type,
      multiline: def.multiline,
      value,
    });
  }

  function _handleFocusName(event: FocusEvent | React.FocusEvent<Element, Element>) {
    props.onFocusName(props.pair, event);
  }

  function _handleFocusValue(event: FocusEvent | React.FocusEvent<Element, Element>) {
    props.onFocusValue(props.pair, event);
  }

  function _handleFocusDescription(event: FocusEvent | React.FocusEvent<Element, Element>) {
    props.onFocusDescription(props.pair, event);
  }

  function _handleBlurName(event: FocusEvent | React.FocusEvent<Element, Element>) {
    props.onBlurName?.(props.pair, event);
  }

  function _handleBlurValue(event: FocusEvent | React.FocusEvent<Element, Element>) {
    props.onBlurValue?.(props.pair, event);
  }

  function _handleBlurDescription(event: FocusEvent | React.FocusEvent<Element, Element>) {
    props.onBlurDescription?.(props.pair, event);
  }

  function _handleDelete() {
    props.onDelete?.(props.pair);
  }

  function _handleKeyDown(event: KeyboardEvent | React.KeyboardEvent<Element>, value?: any) {
    props.onKeyDown?.(props.pair, event, value);
  }

  function _handleAutocompleteNames() {
    const { handleGetAutocompleteNameConstants } = props;

    if (handleGetAutocompleteNameConstants) {
      return handleGetAutocompleteNameConstants(props.pair);
    }

    return [];
  }

  function _handleAutocompleteValues() {
    const { handleGetAutocompleteValueConstants } = props;

    if (handleGetAutocompleteValueConstants) {
      return handleGetAutocompleteValueConstants(props.pair);
    }

    return [];
  }

  function _handleEditMultiline() {
    const { pair, enableNunjucks } = props;
    showModal(CodePromptModal, {
      submitName: 'Done',
      title: `Edit ${pair.name}`,
      defaultValue: pair.value,
      onChange: _handleValueChange,
      enableRender: enableNunjucks,
      mode: pair.multiline || 'text/plain',
      onModeChange: (mode: string) => {
        _handleTypeChange(
          Object.assign({}, pair, {
            multiline: mode,
          }),
        );
      },
    });
  }
  const {
    allowFile,
    allowMultiline,
    className,
    connectDragPreview,
    connectDragSource,
    connectDropTarget,
    descriptionPlaceholder,
    displayDescription,
    forceInput,
    hideButtons,
    isDragging,
    isDraggingOver,
    namePlaceholder,
    noDelete,
    noDropZone,
    pair,
    valueInputType,
    valuePlaceholder,
    readOnly,
    renderLeftIcon,
    sortable,
  } = props;
  const classes = classnames(className, {
    'key-value-editor__row-wrapper': true,
    'key-value-editor__row-wrapper--dragging': isDragging,
    'key-value-editor__row-wrapper--dragging-above': isDraggingOver && dragDirection > 0,
    'key-value-editor__row-wrapper--dragging-below': isDraggingOver && dragDirection < 0,
    'key-value-editor__row-wrapper--disabled': pair.disabled,
  });

  let handle: ConnectDragSource | JSX.Element | undefined | null = null;

  if (sortable) {
    handle = renderLeftIcon ? (
      <div className="key-value-editor__drag">{renderLeftIcon()}</div>
    ) : (
      connectDragSource?.(
        <div className="key-value-editor__drag">
          <i className={'fa ' + (hideButtons ? 'fa-empty' : 'fa-reorder')} />
        </div>,
      )
    );
  }

  const row = (
    <li className={classes}>
      {handle}
      <div className="key-value-editor__row">
        <div
          className={classnames('form-control form-control--underlined form-control--wide', {
            'form-control--inactive': pair.disabled,
          })}
        >
          <OneLineEditor
            ref={nameInputRef}
            placeholder={namePlaceholder || 'Name'}
            defaultValue={pair.name}
            getAutocompleteConstants={_handleAutocompleteNames}
            forceInput={forceInput}
            readOnly={readOnly}
            onBlur={_handleBlurName}
            onChange={_handleNameChange}
            onFocus={_handleFocusName}
            onKeyDown={_handleKeyDown}
          />
        </div>
        <div
          className={classnames('form-control form-control--underlined form-control--wide', {
            'form-control--inactive': pair.disabled,
          })}
        >
          {pair.type === 'file' ? (
            <FileInputButton
              showFileName
              showFileIcon
              className="btn btn--outlined btn--super-duper-compact wide ellipsis"
              path={pair.fileName || ''}
              onChange={_handleFileNameChange}
            />
          ) : (pair.type === 'text' && pair.multiline) ? (
            <button
              className="btn btn--outlined btn--super-duper-compact wide ellipsis"
              onClick={_handleEditMultiline}
            >
              <i className="fa fa-pencil-square-o space-right" />
              {Buffer.from(pair.value, 'utf8').length > 0 ? describeByteSize(Buffer.from(pair.value, 'utf8').length, true) : 'Click to Edit'}
            </button>
          ) : (
            <OneLineEditor
              ref={valueInputRef}
              readOnly={readOnly}
              forceInput={forceInput}
              type={valueInputType || 'text'}
              placeholder={valuePlaceholder || 'Value'}
              defaultValue={pair.value}
              onPaste={_handleValuePaste}
              onChange={_handleValueChange}
              onBlur={_handleBlurValue}
              onKeyDown={_handleKeyDown}
              onFocus={_handleFocusValue}
              getAutocompleteConstants={_handleAutocompleteValues}
            />)}
        </div>
        {displayDescription ? (
          <div
            className={classnames(
              'form-control form-control--underlined form-control--wide no-min-width',
              {
                'form-control--inactive': pair.disabled,
              },
            )}
          >
            <OneLineEditor
              ref={descriptionInputRef}
              readOnly={readOnly}
              forceInput={forceInput}
              placeholder={descriptionPlaceholder || 'Description'}
              defaultValue={pair.description || ''}
              onChange={_handleDescriptionChange}
              onBlur={_handleBlurDescription}
              onKeyDown={_handleKeyDown}
              onFocus={_handleFocusDescription}
            />
          </div>
        ) : null}

        {(hideButtons && (allowMultiline || allowFile)) ? (
          <button>
            <i className="fa fa-empty" />
          </button>
        ) : hideButtons ? null : (allowMultiline || allowFile) ? (
          <Dropdown right>
            <DropdownButton className="tall">
              <i className="fa fa-caret-down" />
            </DropdownButton>
            <DropdownItem
              onClick={_handleTypeChange}
              value={{
                type: 'text',
                multiline: false,
              }}
            >
              Text
            </DropdownItem>
            {allowMultiline && (
              <DropdownItem
                onClick={_handleTypeChange}
                value={{
                  type: 'text',
                  multiline: true,
                }}
              >
                Text (Multi-line)
              </DropdownItem>
            )}
            {allowFile && (
              <DropdownItem
                onClick={_handleTypeChange}
                value={{
                  type: 'file',
                }}
              >
                File
              </DropdownItem>
            )}
          </Dropdown>
        ) : null}

        {!hideButtons ? (
          <Button
            onClick={_handleDisableChange}
            value={!pair.disabled}
            title={pair.disabled ? 'Enable item' : 'Disable item'}
          >
            {pair.disabled ? (
              <i className="fa fa-square-o" />
            ) : (
              <i className="fa fa-check-square-o" />
            )}
          </Button>
        ) : (
          <button>
            <i className="fa fa-empty" />
          </button>
        )}

        {!noDelete &&
          (!hideButtons ? (
            <PromptButton
              key={Math.random()}
              tabIndex={-1}
              confirmMessage=""
              addIcon
              onClick={_handleDelete}
              title="Delete item"
            >
              <i className="fa fa-trash-o" />
            </PromptButton>
          ) : (
            <button>
              <i className="fa fa-empty" />
            </button>
          ))}
      </div>
    </li>
  );

  if (noDropZone) {
    return row;
  } else {
    const dropTarget = connectDropTarget?.(row);
    // @ts-expect-error -- TSCONVERSION investigate whether a cast is actually appropriate here
    return connectDragPreview?.(dropTarget);
  }
});

KeyValueEditorRowInternal.displayName = 'KeyValueEditorRowInternal';

const dragSource = {
  beginDrag(props: Props) {
    return {
      pair: props.pair,
    };
  },
};

function isAbove(monitor: DropTargetMonitor, component: any) {
  const hoveredNode = ReactDOM.findDOMNode(component);
  // @ts-expect-error -- TSCONVERSION
  const hoveredTop = hoveredNode.getBoundingClientRect().top;
  // @ts-expect-error -- TSCONVERSION
  const height = hoveredNode.clientHeight;
  const draggedTop = monitor.getSourceClientOffset()?.y;
  // NOTE: Not quite sure why it's height / 3 (seems to work)
  return draggedTop !== undefined ? hoveredTop > draggedTop - height / 3 : false;
}

const dragTarget = {
  drop(props: Props, monitor: DropTargetMonitor, component: any) {
    if (isAbove(monitor, component)) {
      props.onMove?.(monitor.getItem().pair, props.pair, 1);
    } else {
      props.onMove?.(monitor.getItem().pair, props.pair, -1);
    }
  },

  hover(_props: Props, monitor: DropTargetMonitor, component: any) {
    if (isAbove(monitor, component)) {
      component.setDragDirection(1);
    } else {
      component.setDragDirection(-1);
    }
  },
};

const KeyValueEditorRowFCWithRef: ForwardRefRenderFunction<KeyValueEditorRowInternal, Omit<Props, 'enableNunjucks'>> = (
  props,
  ref
) => {
  const { enabled } = useNunjucksEnabled();

  return <KeyValueEditorRowInternal ref={ref} {...props} enableNunjucks={enabled} />;

};

const KeyValueEditorRowFC = forwardRef(KeyValueEditorRowFCWithRef);

const source = DragSource('KEY_VALUE_EDITOR', dragSource, (connect, monitor) => ({
  connectDragSource: connect.dragSource(),
  connectDragPreview: connect.dragPreview(),
  isDragging: monitor.isDragging(),
}))(KeyValueEditorRowFC);

export const Row = DropTarget('KEY_VALUE_EDITOR', dragTarget, (connect, monitor) => ({
  connectDropTarget: connect.dropTarget(),
  isDraggingOver: monitor.isOver(),
}))(source);

Row.prototype.focusNameEnd = function() {
  this.decoratedRef.current.decoratedRef.current.focusNameEnd();
};

Row.prototype.focusValueEnd = function() {
  this.decoratedRef.current.decoratedRef.current.focusValueEnd();
};

Row.prototype.focusDescriptionEnd = function() {
  this.decoratedRef.current.decoratedRef.current.focusDescriptionEnd();
};
