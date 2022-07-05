import { ipcMain } from 'electron';
import WebSocket from 'ws';

// problems
// -how to deal with handlers, requestid keyed array, where?
// -what are their lifetimes? until app close or disconnect, close connection on request change
// -how to hook up an ipc listener to a react component
// ideas
// -per connection ipc channels

// done
// - can listen to remote messages in renderer over ipc

/*
must
 open connect to given url and listen for responses
 send message to connection above
should

could

maybe
*/
// nice to have ideas
// - handle multiple connections
// - streams ala hoppscotch https://github.com/hoppscotch/hoppscotch/blob/d035262e1a3512df80e02c59184d22cc78350f02/packages/hoppscotch-app/pages/realtime/websocket.vue#L215
// - ipc channel per connection?
// - seperated open and message channels?
export interface WebsocketBridgeAPI {
  open: (options: { url: string }) => void;
  message: (options: { message: string }) => string;
  close: () => string;
}
let temporaryStateHack: WebSocket;
export const registerWebsocketHandlers = () => {
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
};
