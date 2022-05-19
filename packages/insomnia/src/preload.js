const { contextBridge, ipcRenderer } = require('electron');

const main = {
  restart: () => ipcRenderer.send('restart'),
  authorizeUserInWindow: options => ipcRenderer.invoke('authorizeUserInWindow', options),
  setMenuBarVisibility: options => ipcRenderer.send('setMenuBarVisibility', options),
  installPlugin: options => ipcRenderer.invoke('installPlugin', options),
  curlRequest: options => ipcRenderer.invoke('curlRequest', options),
  cancelCurlRequest: options => ipcRenderer.send('cancelCurlRequest', options),
  writeFile: options => ipcRenderer.invoke('writeFile', options),
};
const db = {
  all: type => ipcRenderer.invoke('db.fn', 'all', type),
  batchModifyDocs: ({ upsert = [], remove = [] }) => ipcRenderer.invoke('db.fn', 'batchModifyDocs', { upsert, remove }),
  bufferChanges: (millis = 1000) => ipcRenderer.invoke('db.fn', 'bufferChanges', millis),
  bufferChangesIndefinitely: () => ipcRenderer.invoke('db.fn', 'bufferChangesIndefinitely'),
  count: (type, query = {}) => ipcRenderer.invoke('db.fn', 'count', type, query),
  duplicate: (originalDoc, patch = {}) => ipcRenderer.invoke('db.fn', 'duplicate', originalDoc, patch),
  docCreate: (type, patch) => ipcRenderer.invoke('db.fn', 'docCreate', type, patch),
  docUpdate: (type, patch) => ipcRenderer.invoke('db.fn', 'docUpdate', type, patch),
  find: (type, query = {}, sort = { created: 1 }) => ipcRenderer.invoke('db.fn', 'find', type, query, sort),
  findMostRecentlyModified: (type, query = {}, limit = null,) => ipcRenderer.invoke('db.fn', 'findMostRecentlyModified', type, query, limit),
  flushChanges: (id = 0, fake = false) => ipcRenderer.invoke('db.fn', 'flushChanges', id, fake),
  get: (type, id) => ipcRenderer.invoke('db.fn', 'get', type, id),
  getMostRecentlyModified: (type, query = {}) => ipcRenderer.invoke('db.fn', 'getMostRecentlyModified', type, query),
  getWhere: (type, query) => ipcRenderer.invoke('db.fn', 'getWhere', type, query),
  insert: (doc, fromSync = false, initializeModel = true) => ipcRenderer.invoke('db.fn', 'insert', doc, fromSync, initializeModel),
  onChange: callback => ipcRenderer.on('db.changes', async (_e, changes) => callback(changes)),
  offChange: callback => ipcRenderer.removeListener('db.changes', async (_e, changes) => callback(changes)),
  remove: (doc, fromSync = false) => ipcRenderer.invoke('db.fn', 'remove', doc, fromSync),
  removeWhere: (type, query) => ipcRenderer.invoke('db.fn', 'removeWhere', type, query),
  unsafeRemove: (doc, fromSync = false) => ipcRenderer.invoke('db.fn', 'unsafeRemove', doc, fromSync),
  update: (doc, fromSync = false) => ipcRenderer.invoke('db.fn', 'update', doc, fromSync),
  upsert: (doc, fromSync = false) => ipcRenderer.invoke('db.fn', 'upsert', doc, fromSync),
  withAncestors: (doc, types) => ipcRenderer.invoke('db.fn', 'withAncestors', doc, types),
  withDescendants: (doc, stopType = null) => ipcRenderer.invoke('db.fn', 'withDescendants', doc, stopType),
};

const dialog = {
  showOpenDialog: options => ipcRenderer.invoke('showOpenDialog', options),
  showSaveDialog: options => ipcRenderer.invoke('showSaveDialog', options),
};
const app = {
  getPath: options => ipcRenderer.sendSync('getPath', options),
  getAppPath: options => ipcRenderer.sendSync('getAppPath', options),
};
const shell = {
  showItemInFolder: options => ipcRenderer.send('showItemInFolder', options),
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('main', main);
  contextBridge.exposeInMainWorld('dialog', dialog);
  contextBridge.exposeInMainWorld('app', app);
  contextBridge.exposeInMainWorld('shell', shell);
  contextBridge.exposeInMainWorld('db', db);
} else {
  window.main = main;
  window.dialog = dialog;
  window.app = app;
  window.shell = shell;
  window.db = db;
}
