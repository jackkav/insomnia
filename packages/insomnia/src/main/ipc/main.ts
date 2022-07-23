import { app, dialog, ipcMain } from 'electron';
import { writeFile } from 'fs/promises';
import { extension as mimeExtension } from 'mime-types';

import { exportHarCurrentRequest } from '../../common/har';
import * as models from '../../models';
import { authorizeUserInWindow } from '../../network/o-auth-2/misc';
import installPlugin from '../install-plugin';
import { cancelCurlRequest, curlRequest } from '../network/libcurl-promise';

export interface MainBridgeAPI {
  restart: () => void;
  authorizeUserInWindow: typeof authorizeUserInWindow;
  setMenuBarVisibility: (visible: boolean) => void;
  installPlugin: typeof installPlugin;
  writeFile: (options: { path: string; content: string }) => Promise<string>;
  cancelCurlRequest: typeof cancelCurlRequest;
  curlRequest: typeof curlRequest;
  exportResponse: typeof exportResponse;
}
interface exportResponseOptions {
  responseId: string;
  type: 'HAR' | 'Full Response' | 'Response Body' | 'Response Body Prettified';
}
const exportResponse = async (options: exportResponseOptions): Promise<void> => {
  const { type, responseId } = options;
  const response = await models.response.getById(responseId);
  if (!response) {
    throw new Error(`Response ${responseId} not found`);
  }
  const requestId = response.parentId;
  const request = await models.request.getById(requestId);
  if (!request) {
    throw new Error(`Request ${requestId} not found`);
  }
  const extension = {
    'HAR': 'har',
    'Full Response': 'txt',
    'Response Body Prettified': 'json',
    'Response Body': mimeExtension(response.contentType) || 'unknown',
  };
  const defaultPath = `${request.name.replace(/ +/g, '_')}-${Date.now()}.${extension[type]}`;
  const { filePath } = await dialog.showSaveDialog({
    title: `Export ${type}`,
    buttonLabel: 'Save',
    defaultPath,
  });
  if (!filePath) {
    return;
  }
  if (type === 'HAR') {
    const har = await exportHarCurrentRequest(request, response);
    return writeFile(filePath, JSON.stringify(har, null, '\t'));
  }
  const body = models.response.getBodyBuffer(response)?.toString();
  if (!body) {
    return;
  }
  if (type === 'Full Response') {
    const timeline = models.response.getTimeline(response);
    const headers = timeline.filter(v => v.name === 'HeaderIn').map(v => v.value).join('');
    return writeFile(filePath, headers + '\n\n' + body);
  }
  if (type === 'Response Body Prettified') {
    return writeFile(filePath, JSON.stringify(body, null, '\t'));
  }
  if (type === 'Response Body') {
    return writeFile(filePath, body);
  }
};

export function registerMainHandlers() {
  ipcMain.handle('authorizeUserInWindow', (_, options: Parameters<typeof authorizeUserInWindow>[0]) => {
    const { url, urlSuccessRegex, urlFailureRegex, sessionId } = options;
    return authorizeUserInWindow({ url, urlSuccessRegex, urlFailureRegex, sessionId });
  });

  ipcMain.handle('writeFile', async (_, options: { path: string; content: string }) => {
    try {
      await writeFile(options.filePath, options.output);
      return options.filePath;
    } catch (err) {
      throw new Error(err);
    }
  });

  ipcMain.handle('curlRequest', (_, options: Parameters<typeof curlRequest>[0]) => {
    return curlRequest(options);
  });

  ipcMain.handle('exportResponse', (_, options: Parameters<typeof exportResponse>[0]) => {
    return exportResponse(options);
  });

  ipcMain.on('cancelCurlRequest', (_, requestId: string): void => {
    cancelCurlRequest(requestId);
  });

  ipcMain.handle('installPlugin', (_, lookupName: string) => {
    return installPlugin(lookupName);
  });
  ipcMain.on('restart', () => {
    app.relaunch();
    app.exit();
  });
}
