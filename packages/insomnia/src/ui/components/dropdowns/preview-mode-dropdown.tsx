import React, { FC, useCallback } from 'react';
import { useSelector } from 'react-redux';

import { getPreviewModeName, PREVIEW_MODES, PreviewMode } from '../../../common/constants';
import * as models from '../../../models';
import { isRequest } from '../../../models/request';
import { selectActiveRequest, selectActiveResponse, selectResponsePreviewMode } from '../../redux/selectors';
import { Dropdown } from '../base/dropdown/dropdown';
import { DropdownButton } from '../base/dropdown/dropdown-button';
import { DropdownDivider } from '../base/dropdown/dropdown-divider';
import { DropdownItem } from '../base/dropdown/dropdown-item';

export const PreviewModeDropdown: FC = ({
}) => {
  const request = useSelector(selectActiveRequest);
  const previewMode = useSelector(selectResponsePreviewMode);
  const response = useSelector(selectActiveResponse);

  const handleClick = async (previewMode: PreviewMode) => {
    if (!request || !isRequest(request)) {
      return;
    }
    return models.requestMeta.updateOrCreateByParentId(request._id, { previewMode });
  };
  const handleDownloadPrettify = useCallback(() => window.main.exportResponse({ responseId:response._id, type: 'Response Body Prettified' }), [response._id]);

  const handleDownloadNormal = useCallback(() => window.main.exportResponse({ responseId:response._id, type: 'Response Body' }), [response._id]);

  const exportAsHAR = useCallback(() => {
    window.main.exportResponse({ responseId: response._id, type:'HAR' });
  }, [response._id]);

  const exportDebugFile = useCallback(() => {
    window.main.exportResponse({ responseId: response._id, type:'Full Response' });
  }, [response._id]);

  const copyToClipboard = useCallback(() => {
    if (!response) {
      return;
    }
    const body = models.response.getBodyBuffer(response)?.toString('utf8');
    if (body) {
      window.clipboard.writeText(body);
    }
  }, [response]);

  const shouldPrettifyOption = response.contentType.includes('json');
  return <Dropdown beside>
    <DropdownButton className="tall">
      {getPreviewModeName(previewMode)}
      <i className="fa fa-caret-down space-left" />
    </DropdownButton>
    <DropdownDivider>Preview Mode</DropdownDivider>
    {PREVIEW_MODES.map(mode => <DropdownItem key={mode} onClick={handleClick} value={mode}>
      {previewMode === mode ? <i className="fa fa-check" /> : <i className="fa fa-empty" />}
      {getPreviewModeName(mode, true)}
    </DropdownItem>)}
    <DropdownDivider>Actions</DropdownDivider>
    <DropdownItem onClick={copyToClipboard}>
      <i className="fa fa-copy" />
      Copy raw response
    </DropdownItem>
    <DropdownItem onClick={handleDownloadNormal}>
      <i className="fa fa-save" />
      Export raw response
    </DropdownItem>
    {shouldPrettifyOption && <DropdownItem onClick={handleDownloadPrettify}>
      <i className="fa fa-save" />
      Export prettified response
    </DropdownItem>}
    <DropdownItem onClick={exportDebugFile}>
      <i className="fa fa-bug" />
      Export HTTP debug
    </DropdownItem>
    <DropdownItem onClick={exportAsHAR}>
      <i className="fa fa-save" />
      Export as HAR
    </DropdownItem>
  </Dropdown>;
};
