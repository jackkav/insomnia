
import { OnChange as MonacoOnChange  } from '@monaco-editor/react';
import React, { FC, useCallback } from 'react';
import { useSelector } from 'react-redux';

import * as models from '../../../models';
import { isRequest,
  //  isWebSocketRequest, MessageType, WebSocketRequest
} from '../../../models/request';
import { selectActiveRequest } from '../../redux/selectors';
import { Dropdown } from '../base/dropdown/dropdown';
import { DropdownButton } from '../base/dropdown/dropdown-button';
import { DropdownDivider } from '../base/dropdown/dropdown-divider';
import { DropdownItem } from '../base/dropdown/dropdown-item';
import { ErrorBoundary } from '../error-boundary';
import { Monaco } from './monaco';

export const WebSocketMessageTab: FC = () => {

  const activeRequest = useSelector(selectActiveRequest);
  console.log({ activeRequest });

  const onClick = useCallback((value: MessageType) => {
    if (!activeRequest?._id) {
      return;
    }
    if (!isRequest(activeRequest)) {
      return;
    }

    // if (!isWebSocketRequest(activeRequest)) {
    //   return;
    // }

    // models.request.update(activeRequest, {
    //   webSocketStuffLol: {
    //     ...activeRequest.webSocketStuffLol,
    //     messageType: value,
    //   },
    // });
  }, [activeRequest]);

  if (activeRequest === null) {
    return null;
  }

  if (!isRequest(activeRequest)) {
    // lol gRPC bites us yet again
    return null;
  }

  // if (!isWebSocketRequest(activeRequest)) {
  //   return null;
  // }

  const {
    // webSocketStuffLol: {
    //   messageType,
    // },
  } = activeRequest;

  return (
    <Dropdown beside>
      <DropdownButton className="tall">
        {/* {messageType} */}
        <i className="fa fa-caret-down space-left" />
      </DropdownButton>

      <DropdownItem onClick={onClick} value="None">None</DropdownItem>

      <DropdownDivider>Plain Text</DropdownDivider>
      <DropdownItem onClick={onClick} value="JSON">JSON</DropdownItem>
      <DropdownItem onClick={onClick} value="XML">XML</DropdownItem>
      <DropdownItem onClick={onClick} value="HTML">HTML</DropdownItem>
      <DropdownItem onClick={onClick} value="Protobuf">Protobuf</DropdownItem>
      <DropdownItem onClick={onClick} value="Text">Text</DropdownItem>

      <DropdownDivider>Binary</DropdownDivider>
      <DropdownItem onClick={onClick} value="Hexadecimal">Hexadecimal</DropdownItem>
      <DropdownItem onClick={onClick} value="Base64">Base64</DropdownItem>
      <DropdownItem onClick={onClick} value="File">File</DropdownItem>
    </Dropdown>
  );
};

export const WebSocketMessageEditor: FC = () => {
  const activeRequest = useSelector(selectActiveRequest);

  const onChange = useCallback<MonacoOnChange>((value, event) => {
    console.log('onChange', { value, event });
    if (!activeRequest?._id) {
      return;
    }
    if (!isRequest(activeRequest)) {
      return;
    }

    // if (!isWebSocketRequest(activeRequest)) {
    //   return;
    // }

    const fn = async () => {
      await models.request.update(activeRequest, {
        body: {
          ...activeRequest.body,
          text: value,
        },
      });
    };

    fn();

  }, [activeRequest]);

  if (activeRequest === null) {
    return null;
  }

  if (!isRequest(activeRequest)) {
    // lol gRPC bites us yet again
    return null;
  }

  // if (!isWebSocketRequest(activeRequest)) {
  //   return null;
  // }

  return (
    <div style={{ height: '100%' }}>
      <ErrorBoundary>
        <Monaco
          language={'text'}
          onChange={onChange}
        />
      </ErrorBoundary>
    </div>
  );
};
