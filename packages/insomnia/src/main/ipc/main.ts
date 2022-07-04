import { app, ipcMain } from 'electron';
import { writeFile } from 'fs/promises';
import WebSocket from 'ws';

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
  websocket: {
    open: (options: { url: string }) => void;
    message: (options: { message: string }) => string;
    close: () => string;
  };
}
// problems
// -how to deal with handlers, requestid keyed array, where?
// -what are their lifetimes? until app close or disconnect, close connection on request change
// -how to hook up an ipc listener to a react component
// ideas
// -per connection ipc channels

// done
// - can listen to remote messages in renderer over ipc

// todo
// - handle multiple connections

let temporaryStateHack: WebSocket;
export function registerMainHandlers() {
  ipcMain.on('websocket.open', (event, options: { url: string }) => {
    console.log('Connecting to ' + options.url);
    try {
      const ws = new WebSocket(options.url);
      ws.on('open', () => {
        event.sender.send('asynchronous-reply', 'Connected to ' + options.url);

        console.log('Connected to ' + options.url);
        ws.send('test123');
        temporaryStateHack = ws;
      });
      ws.on('message', data => {
        event.sender.send('asynchronous-reply', data);
        console.log('received in main: ' + data);
      });
    } catch (e) {
      console.error(e);
    }
  });

  ipcMain.handle('websocket.message', (_, options: { message: string }) => {
    if (!temporaryStateHack) {
      return;
    }
    const ws = temporaryStateHack;
    ws.send(options.message);
    console.log('sent: ' + options.message);
    return 'sent: ' + options.message;
  });

  ipcMain.handle('websocket.close', () => {
    if (!temporaryStateHack) {
      return;
    }
    const ws = temporaryStateHack;
    ws.close();
    ws.on('close', () => {
      console.log('Disconnected from ', ws._url);
    });
    return 'success';
  });

  ipcMain.handle('authorizeUserInWindow', (_, options: Parameters<typeof authorizeUserInWindow>[0]) => {
    const { url, urlSuccessRegex, urlFailureRegex, sessionId } = options;
    return authorizeUserInWindow({ url, urlSuccessRegex, urlFailureRegex, sessionId });
  });

  ipcMain.handle('writeFile', async (_, options: { path: string; content: string }) => {
    try {
      await writeFile(options.path, options.content);
      return options.path;
    } catch (err) {
      throw new Error(err);
    }
  });

  ipcMain.handle('curlRequest', (_, options: Parameters<typeof curlRequest>[0]) => {
    return curlRequest(options);
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
