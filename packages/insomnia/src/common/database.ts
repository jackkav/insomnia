import electron from 'electron';
import NeDB from 'nedb';
import fsPath from 'path';

import { mustGetModel } from '../models';
import { CookieJar } from '../models/cookie-jar';
import { GitRepository } from '../models/git-repository';
import { getMonkeyPatchedControlledSettings } from '../models/helpers/settings';
import type { BaseModel } from '../models/index';
import * as models from '../models/index';
import { isSettings } from '../models/settings';
import type { Workspace } from '../models/workspace';
import { DB_PERSIST_INTERVAL } from './constants';
import { generateId } from './misc';

export interface Query {
  _id?: string | SpecificQuery;
  parentId?: string | null;
  remoteId?: string | null;
  plugin?: string;
  key?: string;
  environmentId?: string | null;
  protoFileId?: string;
}

type Sort = Record<string, any>;

interface Operation {
  upsert?: BaseModel[];
  remove?: BaseModel[];
}

export interface SpecificQuery {
  $gt?: number;
  $in?: string[];
  $nin?: string[];
}

export type ModelQuery<T extends BaseModel> = Partial<Record<keyof T, SpecificQuery>>;
const all = (type: string) => find(type);
const batchModifyDocs = async ({ upsert: upserts, remove: removes }: Operation) => {
  const flushId = await bufferChanges();
  // Perform from least to most dangerous
  await Promise.all(upserts?.map(doc => upsert(doc, true)));
  await Promise.all(removes?.map(doc => unsafeRemove(doc, true)));

  await flushChanges(flushId);
};
// NOTE: seems buffer and flush is intended to offer atomicity
// Ideas: attempt it without file scoped variables and timeouts
const bufferChanges = async (millis = 1000) => {
  bufferingChanges = true;
  setTimeout(flushChanges, millis);
  return ++bufferChangesId;
};
const bufferChangesIndefinitely = () => {
  bufferingChanges = true;
  return ++bufferChangesId;
};
const flushChanges = async (id = 0, fake = false) => {
  // Only flush if ID is 0 or the current flush ID is the same as passed
  if (id !== 0 && bufferChangesId !== id) {
    return;
  }

  bufferingChanges = false;
  const changes = [...changeBuffer];
  changeBuffer = [];

  if (changes.length === 0) {
    // No work to do
    return;
  }

  if (fake) {
    console.log(`[db] Dropped ${changes.length} changes.`);
    return;
  }

  // NOTE: this is exclusively for deleting response and timeline files and could be moved somewhere more appropriate
  for (const [type, doc] of changes) {
    // TODO(TSCONVERSION) what's returned here is the entire model implementation, not just a model
    // The type definition will be a little confusing
    const m: Record<string, any> | null = models.getModel(doc.type);

    if (!m) {
      continue;
    }

    if (type === 'remove' && typeof m.hookRemove === 'function') {
      try {
        await m.hookRemove(doc, console.log);
      } catch (err) {
        console.log(`[db] Delete hook failed for ${type} ${doc._id}: ${err.message}`);
      }
    }
  }
  // Notify remote listeners
  const isMainContext = process.type === 'browser';
  if (isMainContext) {
    const windows = electron.BrowserWindow.getAllWindows();

    for (const window of windows) {
      window.webContents.send('db.changes', changes);
    }
  }
};
const count = async (type: string, query: Query = {}) => {
  return new Promise<number>((resolve, reject) => {
    (db[type] as NeDB).count(query, (err, count) => {
      if (err) {
        return reject(err);
      }

      resolve(count);
    });
  });
};
const docCreate = async (type: string, ...patches) => {
  const doc = await models.initModel(
    type,
    ...patches,
    // Fields that the user can't touch
    {
      type: type,
    },
  );
  return insert(doc);
};
const docUpdate = async (originalDoc, ...patches) => {
  const doc = await models.initModel(
    originalDoc.type,
    originalDoc,

    // NOTE: This is before `patches` because we want `patch.modified` to win if it has it
    {
      modified: Date.now(),
    },
    ...patches,
  );
  return update(doc);
};
const duplicate = async (originalDoc, patch = {}) => {
  const flushId = await bufferChanges();
  async function next(docToCopy, patch) {
    const model = mustGetModel(docToCopy.type);
    const overrides = {
      _id: generateId(model.prefix),
      modified: Date.now(),
      created: Date.now(),
      type: docToCopy.type, // Ensure this is not overwritten by the patch
    };

    // 1. Copy the doc
    const newDoc = Object.assign({}, docToCopy, patch, overrides);

    // Don't initialize the model during insert, and simply duplicate
    const createdDoc = await insert(newDoc, false, false);

    // 2. Get all the children
    for (const type of Object.keys(db)) {
      // Note: We never want to duplicate a response
      if (!models.canDuplicate(type)) {
        continue;
      }

      const parentId = docToCopy._id;
      const children = await find(type, { parentId });

      for (const doc of children) {
        await next(doc, { parentId: createdDoc._id });
      }
    }

    return createdDoc;
  }

  const createdDoc = await next(originalDoc, patch);
  await flushChanges(flushId);
  return createdDoc;
};
const find = async (
  type: string,
  query: Query | string = {},
  sort: Sort = { created: 1 },
) => {
  return new Promise((resolve, reject) => {
    (db[type] as NeDB)
      .find(query)
      .sort(sort)
      .exec(async (err, rawDocs) => {
        if (err) {
          reject(err);
          return;
        }
        const docs = [];
        for (const rawDoc of rawDocs) {
          docs.push(await models.initModel(type, rawDoc));
        }
        resolve(docs);
      });
  });
};
const findMostRecentlyModified =  async (
  type: string,
  query: Query = {},
  limit: number | null = null,
) => {
  return new Promise(resolve => {
    (db[type] as NeDB)
      .find(query)
      .sort({
        modified: -1,
      })
      // @ts-expect-error -- TSCONVERSION limit shouldn't be applied if it's null, or default to something that means no-limit
      .limit(limit)
      .exec(async (err, rawDocs) => {
        if (err) {
          console.warn('[db] Failed to find docs', err);
          resolve([]);
          return;
        }

        const docs = [];

        for (const rawDoc of rawDocs) {
          docs.push(await models.initModel(type, rawDoc));
        }

        resolve(docs);
      });
  });
};
const get = async (type: string, id?: string) => {
  // Short circuit IDs used to represent nothing
  if (!id || id === 'n/a') {
    return null;
  } else {
    return getWhere(type, { _id: id });
  }
};
const getMostRecentlyModified = async (type: string, query: Query = {}) => {
  const docs = await findMostRecentlyModified(type, query, 1);
  return docs.length ? docs[0] : null;
};
const getWhere = async (type: string, query) => {
  const docs = await find(type, query);
  return docs.length ? docs[0] : null;
};
const insert = async (doc, fromSync = false, initializeModel = true) => {
  return new Promise(async (resolve, reject) => {
    let docWithDefaults = null;

    try {
      if (initializeModel) {
        docWithDefaults = await models.initModel<T>(doc.type, doc);
      } else {
        docWithDefaults = doc;
      }
    } catch (err) {
      return reject(err);
    }

    (db[doc.type] as NeDB).insert(docWithDefaults, (err, newDoc: T) => {
      if (err) {
        return reject(err);
      }

      resolve(newDoc);
      // NOTE: This needs to be after we resolve
      notifyOfChange('insert', newDoc, fromSync);
    });
  });
};
const remove = async (doc, fromSync = false) => {
  const flushId = await bufferChanges();

  const docs = await withDescendants(doc);
  const docIds = docs.map(d => d._id);
  const types = [...new Set(docs.map(d => d.type))];

  // Don't really need to wait for this to be over;
  types.map(t =>
    db[t].remove(
      {
        _id: {
          $in: docIds,
        },
      },
      {
        multi: true,
      },
    ),
  );

  docs.map(d => notifyOfChange('remove', d, fromSync));
  await flushChanges(flushId);
};
const removeWhere = async (type: string, query: Query) => {
  const flushId = await bufferChanges();

  for (const doc of await find(type, query)) {
    const docs = await withDescendants(doc);
    const docIds = docs.map(d => d._id);
    const types = [...new Set(docs.map(d => d.type))];

    // Don't really need to wait for this to be over;
    types.map(t =>
      db[t].remove(
        {
          _id: {
            $in: docIds,
          },
        },
        {
          multi: true,
        },
      ),
    );
    docs.map(d => notifyOfChange('remove', d, false));
  }

  await flushChanges(flushId);
};
const unsafeRemove = async (doc, fromSync = false)  => {
  (db[doc.type] as NeDB).remove({ _id: doc._id });
  notifyOfChange('remove', doc, fromSync);
};
const update =  async (doc, fromSync = false) => {
  return new Promise(async (resolve, reject) => {
    let docWithDefaults;

    try {
      docWithDefaults = await models.initModel(doc.type, doc);
    } catch (err) {
      return reject(err);
    }

    (db[doc.type] as NeDB).update(
      { _id: docWithDefaults._id },
      docWithDefaults,
      // TODO(TSCONVERSION) see comment below, upsert can happen automatically as part of the update
      // @ts-expect-error -- TSCONVERSION expects 4 args but only sent 3. Need to validate what UpdateOptions should be.
      err => {
        if (err) {
          return reject(err);
        }

        resolve(docWithDefaults);
        // NOTE: This needs to be after we resolve
        notifyOfChange('update', docWithDefaults, fromSync);
      },
    );
  });
};
const upsert =  async (doc, fromSync = false) => {
  const existingDoc = await get(doc.type, doc._id);
  if (existingDoc) {
    return update(doc, fromSync);
  } else {
    return insert(doc, fromSync);
  }
};
const withAncestors = async (doc, types: string[] = Object.keys(db)) => {
  if (!doc) {
    return [];
  }

  let docsToReturn = doc ? [doc] : [];

  async function next(docs) {
    const foundDocs = [];

    for (const d of docs) {
      for (const type of types) {
        // If the doc is null, we want to search for parentId === null
        const another = await get(type, d.parentId);
        another && foundDocs.push(another);
      }
    }

    if (foundDocs.length === 0) {
      // Didn't find anything. We're done
      return docsToReturn;
    }

    // Continue searching for children
    docsToReturn = [
      ...docsToReturn,
      ...foundDocs,
    ];
    return next(foundDocs);
  }

  return next([doc]);
};
const withDescendants = async (doc, stopType: string | null = null): Promise<BaseModel[]> => {
  let docsToReturn: BaseModel[] = doc ? [doc] : [];

  async function next(docs: (BaseModel | null)[]): Promise<BaseModel[]> {
    let foundDocs: BaseModel[] = [];

    for (const doc of docs) {
      if (stopType && doc && doc.type === stopType) {
        continue;
      }

      const promises = [];

      for (const type of Object.keys(db)) {
        // If the doc is null, we want to search for parentId === null
        const parentId = doc ? doc._id : null;
        const promise = find(type, { parentId });
        promises.push(promise);
      }

      for (const more of await Promise.all(promises)) {
        foundDocs = [
          ...foundDocs,
          ...more,
        ];
      }
    }

    if (foundDocs.length === 0) {
      // Didn't find anything. We're done
      return docsToReturn;
    }

    // Continue searching for children
    docsToReturn = [...docsToReturn, ...foundDocs];
    return next(foundDocs);
  }

  return next([doc]);
};

// NOTE: this DB object apears to be an array of NeDB instances which encapsulated here and exposed as a object of polymorphic self referencial functions
// Idea: expose the instances, or a subset of the functions in them?
interface DB {
  [index: string]: NeDB;
}

const db: DB = {} as DB;
const neDBWrapper = {
  all,
  batchModifyDocs,
  bufferChanges,
  // NOTE: only used for addDirectory()
  bufferChangesIndefinitely,
  count,
  docCreate,
  docUpdate,
  duplicate,
  find,
  findMostRecentlyModified,
  flushChanges,
  get,
  getMostRecentlyModified,
  getWhere,
  insert,
  remove,
  removeWhere,
  /** Removes entries without removing their children */
  unsafeRemove,
  update,
  upsert,
  withAncestors,

  withDescendants,
};
export const initializeDatabase = async (
  types: string[],
  config: NeDB.DataStoreOptions = {},
) => {
  // Fill in the defaults
  const pathToUserData = process.env['INSOMNIA_DATA_PATH'] || electron.app.getPath('userData');
  for (const modelType of types) {
    if (db[modelType]) {
      console.log(`[db] Already initialized DB.${modelType}`);
      continue;
    }
    const filename = fsPath.join(pathToUserData, `insomnia.${modelType}.db`);
    // NOTE: makes a new nedb instance for every document
    const collection = new NeDB({
      autoload: true,
      corruptAlertThreshold: 0.9,
      ...(config.inMemoryOnly ? {} : { filename }),
      ...config,
    });

    collection.persistence.setAutocompactionInterval(DB_PERSIST_INTERVAL);
    db[modelType] = collection;
  }

  if (!config.inMemoryOnly) {
    // NOTE: listens for ipc calls from renderer
    electron.ipcMain.handle('db.fn', async (_, fnName, ...args) => {
      try {
        console.log('handled ', fnName, ...args);
        return await neDBWrapper[fnName](...args);
      } catch (err) {
        console.error('something went wrong');
        return {
          message: err.message,
          stack: err.stack,
        };
      }
    });
    await _repairDatabase();
    console.log(`[db] Initialized DB at ${pathToUserData}`);
  }

  // NOTE: yet another way to delete responses
  for (const model of models.all()) {
    // @ts-expect-error -- TSCONVERSION optional type on response
    if (typeof model.hookDatabaseInit === 'function') {
      // @ts-expect-error -- TSCONVERSION optional type on response
      await model.hookDatabaseInit?.(console.log);
    }
  }
};

let bufferingChanges = false;
let bufferChangesId = 1;

type ChangeBufferEvent = [
  event: string,
  doc: BaseModel,
  fromSync: boolean
];

let changeBuffer: ChangeBufferEvent[] = [];

async function notifyOfChange<T extends BaseModel>(event: string, doc: T, fromSync: boolean) {
  let updatedDoc = doc;

  // NOTE: this monkeypatching is temporary, and was determined to have the smallest blast radius if it exists here (rather than, say, a reducer or an action creator).
  // see: INS-1059
  if (isSettings(doc)) {
    updatedDoc = getMonkeyPatchedControlledSettings(doc);
  }

  changeBuffer.push([event, updatedDoc, fromSync]);

  // Flush right away if we're not buffering
  if (!bufferingChanges) {
    await flushChanges();
  }
}

/**
 * Run various database repair scripts
 */
export async function _repairDatabase() {
  console.log('[fix] Running database repairs');

  for (const workspace of await find(models.workspace.type)) {
    await _repairBaseEnvironments(workspace);
    await _fixMultipleCookieJars(workspace);
    await _applyApiSpecName(workspace);
  }

  for (const gitRepository of await find(models.gitRepository.type)) {
    await _fixOldGitURIs(gitRepository);
  }
}

/**
 * This function ensures that apiSpec exists for each workspace
 * If the filename on the apiSpec is not set or is the default initialized name
 * It will apply the workspace name to it
 */
async function _applyApiSpecName(workspace: Workspace) {
  const apiSpec = await models.apiSpec.getByParentId(workspace._id);
  if (apiSpec === null) {
    return;
  }

  if (!apiSpec.fileName || apiSpec.fileName === models.apiSpec.init().fileName) {
    await models.apiSpec.update(apiSpec, {
      fileName: workspace.name,
    });
  }
}

/**
 * This function repairs workspaces that have multiple base environments. Since a workspace
 * can only have one, this function walks over all base environments, merges the data, and
 * moves all children as well.
 */
async function _repairBaseEnvironments(workspace: Workspace) {
  const baseEnvironments = await find(models.environment.type, {
    parentId: workspace._id,
  });

  // Nothing to do here
  if (baseEnvironments.length <= 1) {
    return;
  }

  const chosenBase = baseEnvironments[0];

  for (const baseEnvironment of baseEnvironments) {
    if (baseEnvironment._id === chosenBase._id) {
      continue;
    }

    chosenBase.data = Object.assign(baseEnvironment.data, chosenBase.data);
    const subEnvironments = await find(models.environment.type, {
      parentId: baseEnvironment._id,
    });

    for (const subEnvironment of subEnvironments) {
      await docUpdate(subEnvironment, {
        parentId: chosenBase._id,
      });
    }

    // Remove unnecessary base env
    await remove(baseEnvironment);
  }

  // Update remaining base env
  await update(chosenBase);
  console.log(`[fix] Merged ${baseEnvironments.length} base environments under ${workspace.name}`);
}

/**
 * This function repairs workspaces that have multiple cookie jars. Since a workspace
 * can only have one, this function walks over all jars and merges them and their cookies
 * together.
 */
async function _fixMultipleCookieJars(workspace: Workspace) {
  const cookieJars = await find<CookieJar>(models.cookieJar.type, {
    parentId: workspace._id,
  });

  // Nothing to do here
  if (cookieJars.length <= 1) {
    return;
  }

  const chosenJar = cookieJars[0];

  for (const cookieJar of cookieJars) {
    if (cookieJar._id === chosenJar._id) {
      continue;
    }

    for (const cookie of cookieJar.cookies) {
      if (chosenJar.cookies.find(c => c.id === cookie.id)) {
        continue;
      }

      chosenJar.cookies.push(cookie);
    }

    // Remove unnecessary jar
    await remove(cookieJar);
  }

  // Update remaining jar
  await update(chosenJar);
  console.log(`[fix] Merged ${cookieJars.length} cookie jars under ${workspace.name}`);
}

// Append .git to old git URIs to mimic previous isomorphic-git behaviour
async function _fixOldGitURIs(doc: GitRepository) {
  if (!doc.uriNeedsMigration) {
    return;
  }

  if (!doc.uri.endsWith('.git')) {
    doc.uri += '.git';
  }

  doc.uriNeedsMigration = false;
  await update(doc);
  console.log(`[fix] Fixed git URI for ${doc._id}`);
}

export const database = process.type === 'renderer' ? window.db : neDBWrapper;
