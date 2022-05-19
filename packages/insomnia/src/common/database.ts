/* eslint-disable prefer-rest-params -- don't want to change ...arguments usage for these sensitive functions without more testing */
import electron from 'electron';
import NeDB from 'nedb';
import fsPath from 'path';

import { mustGetModel } from '../models';
import { CookieJar } from '../models/cookie-jar';
import { Environment } from '../models/environment';
import { GitRepository } from '../models/git-repository';
import { getMonkeyPatchedControlledSettings } from '../models/helpers/settings';
import type { BaseModel } from '../models/index';
import * as models from '../models/index';
import { isSettings } from '../models/settings';
import type { Workspace } from '../models/workspace';
import { DB_PERSIST_INTERVAL } from './constants';
import { getDataDirectory } from './electron-helpers';
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

const olddatabase = {
  all: async function <T extends BaseModel>(type: string) {
    return olddatabase.find<T>(type);
  },

  batchModifyDocs: async function({ upsert = [], remove = [] }: Operation) {
    const flushId = await olddatabase.bufferChanges();
    // Perform from least to most dangerous
    await Promise.all(upsert.map(doc => olddatabase.upsert(doc, true)));
    await Promise.all(remove.map(doc => olddatabase.unsafeRemove(doc, true)));

    await olddatabase.flushChanges(flushId);
  },

  /** buffers database changes and returns a buffer id */
  bufferChanges: async function(millis = 1000) {
    bufferingChanges = true;
    setTimeout(olddatabase.flushChanges, millis);
    return ++bufferChangesId;
  },

  /** buffers database changes and returns a buffer id */
  bufferChangesIndefinitely: async function() {
    bufferingChanges = true;
    return ++bufferChangesId;
  },

  count: async function <T extends BaseModel>(type: string, query: Query = {}) {
    return new Promise<number>((resolve, reject) => {
      (db[type] as NeDB<T>).count(query, (err, count) => {
        if (err) {
          return reject(err);
        }

        resolve(count);
      });
    });
  },

  docCreate: async <T extends BaseModel>(type: string, ...patches: Patch<T>[]) => {
    const doc = await models.initModel<T>(
      type,
      ...patches,
      // Fields that the user can't touch
      {
        type: type,
      },
    );
    return olddatabase.insert<T>(doc);
  },

  docUpdate: async <T extends BaseModel>(originalDoc: T, ...patches: Patch<T>[]) => {
    // No need to re-initialize the model during update; originalDoc will be in a valid state by virtue of loading
    const doc = await models.initModel<T>(
      originalDoc.type,
      originalDoc,

      // NOTE: This is before `patches` because we want `patch.modified` to win if it has it
      {
        modified: Date.now(),
      },
      ...patches,
    );
    return olddatabase.update<T>(doc);
  },

  duplicate: async function <T extends BaseModel>(originalDoc: T, patch: Patch<T> = {}) {
    const flushId = await olddatabase.bufferChanges();
    async function next<T extends BaseModel>(docToCopy: T, patch: Patch<T>) {
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
      const createdDoc = await olddatabase.insert(newDoc, false, false);

      // 2. Get all the children
      for (const type of Object.keys(db)) {
        // Note: We never want to duplicate a response
        if (!models.canDuplicate(type)) {
          continue;
        }

        const parentId = docToCopy._id;
        const children = await olddatabase.find(type, { parentId });

        for (const doc of children) {
          await next(doc, { parentId: createdDoc._id });
        }
      }

      return createdDoc;
    }

    const createdDoc = await next(originalDoc, patch);
    await olddatabase.flushChanges(flushId);
    return createdDoc;
  },

  find: async function <T extends BaseModel>(
    type: string,
    query: Query | string = {},
    sort: Sort = { created: 1 },
  ) {
    return new Promise<T[]>((resolve, reject) => {
      (db[type] as NeDB<T>)
        .find(query)
        .sort(sort)
        .exec(async (err, rawDocs) => {
          if (err) {
            reject(err);
            return;
          }

          const docs: T[] = [];

          for (const rawDoc of rawDocs) {
            docs.push(await models.initModel(type, rawDoc));
          }

          resolve(docs);
        });
    });
  },

  findMostRecentlyModified: async function <T extends BaseModel>(
    type: string,
    query: Query = {},
    limit: number | null = null,
  ) {
    return new Promise<T[]>(resolve => {
      (db[type] as NeDB<T>)
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

          const docs: T[] = [];

          for (const rawDoc of rawDocs) {
            docs.push(await models.initModel(type, rawDoc));
          }

          resolve(docs);
        });
    });
  },

  flushChanges: async function(id = 0, fake = false) {
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
  },

  get: async function <T extends BaseModel>(type: string, id?: string) {
    // Short circuit IDs used to represent nothing
    if (!id || id === 'n/a') {
      return null;
    } else {
      return olddatabase.getWhere<T>(type, { _id: id });
    }
  },

  getMostRecentlyModified: async function <T extends BaseModel>(type: string, query: Query = {}) {
    const docs = await olddatabase.findMostRecentlyModified<T>(type, query, 1);
    return docs.length ? docs[0] : null;
  },

  getWhere: async function <T extends BaseModel>(type: string, query: ModelQuery<T> | Query) {
    // @ts-expect-error -- TSCONVERSION type narrowing needed
    const docs = await olddatabase.find<T>(type, query);
    return docs.length ? docs[0] : null;
  },

  insert: async function <T extends BaseModel>(doc: T, fromSync = false, initializeModel = true) {
    return new Promise<T>(async (resolve, reject) => {
      let docWithDefaults: T | null = null;

      try {
        if (initializeModel) {
          docWithDefaults = await models.initModel<T>(doc.type, doc);
        } else {
          docWithDefaults = doc;
        }
      } catch (err) {
        return reject(err);
      }

      (db[doc.type] as NeDB<T>).insert(docWithDefaults, (err, newDoc: T) => {
        if (err) {
          return reject(err);
        }

        resolve(newDoc);
        // NOTE: This needs to be after we resolve
        notifyOfChange('insert', newDoc, fromSync);
      });
    });
  },

  remove: async function <T extends BaseModel>(doc: T, fromSync = false) {
    const flushId = await olddatabase.bufferChanges();

    const docs = await olddatabase.withDescendants(doc);
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
    await olddatabase.flushChanges(flushId);
  },

  removeWhere: async function <T extends BaseModel>(type: string, query: Query) {
    const flushId = await olddatabase.bufferChanges();

    for (const doc of await olddatabase.find<T>(type, query)) {
      const docs = await olddatabase.withDescendants(doc);
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

    await olddatabase.flushChanges(flushId);
  },

  /** Removes entries without removing their children */
  unsafeRemove: async function <T extends BaseModel>(doc: T, fromSync = false) {
    (db[doc.type] as NeDB<T>).remove({ _id: doc._id });
    notifyOfChange('remove', doc, fromSync);
  },

  update: async function <T extends BaseModel>(doc: T, fromSync = false) {
    return new Promise<T>(async (resolve, reject) => {
      let docWithDefaults: T;

      try {
        docWithDefaults = await models.initModel<T>(doc.type, doc);
      } catch (err) {
        return reject(err);
      }

      (db[doc.type] as NeDB<T>).update(
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
  },

  // TODO(TSCONVERSION) the update method above can now take an upsert property
  upsert: async function <T extends BaseModel>(doc: T, fromSync = false) {
    const existingDoc = await olddatabase.get<T>(doc.type, doc._id);
    if (existingDoc) {
      return olddatabase.update<T>(doc, fromSync);
    } else {
      return olddatabase.insert<T>(doc, fromSync);
    }
  },

  withAncestors: async function <T extends BaseModel>(doc: T | null, types: string[] = Object.keys(db)) {
    if (!doc) {
      return [];
    }

    let docsToReturn: T[] = doc ? [doc] : [];

    async function next(docs: T[]): Promise<T[]> {
      const foundDocs: T[] = [];

      for (const d of docs) {
        for (const type of types) {
          // If the doc is null, we want to search for parentId === null
          const another = await olddatabase.get<T>(type, d.parentId);
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
  },

  withDescendants: async function <T extends BaseModel>(doc: T | null, stopType: string | null = null): Promise<BaseModel[]> {
    let docsToReturn: BaseModel[] = doc ? [doc] : [];

    async function next(docs: (BaseModel | null)[]): Promise<BaseModel[]> {
      let foundDocs: BaseModel[] = [];

      for (const doc of docs) {
        if (stopType && doc && doc.type === stopType) {
          continue;
        }

        const promises: Promise<BaseModel[]>[] = [];

        for (const type of Object.keys(db)) {
          // If the doc is null, we want to search for parentId === null
          const parentId = doc ? doc._id : null;
          const promise = olddatabase.find(type, { parentId });
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
  },
};

interface DB {
    [index: string]: NeDB;
}

const db: DB = {} as DB;

const initDatabase = async (
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
      ...(config.inMemoryOnly ? { } : { filename }),
      ...config,
    });

    collection.persistence.setAutocompactionInterval(DB_PERSIST_INTERVAL);
    db[modelType] = collection;
  }
  if (config.inMemoryOnly) {
    return;
  }
  // NOTE: listens for ipc calls from renderer
  electron.ipcMain.handle('db.fn', async (_, fnName, ...args) => {
    try {
      console.log('handled ', fnName, ...args);
      return await olddatabase[fnName](...args);
    } catch (err) {
      console.error('something went wrong');
      return {
        message: err.message,
        stack: err.stack,
      };
    }
  });

  // NOTE: Only repair the DB if we're not running in memory. Repairing here causes tests to hang indefinitely for some reason.
  // TODO: Figure out why this makes tests hang
  if (!config.inMemoryOnly) {
    await _repairDatabase();
    console.log(`[db] Initialized DB at ${pathToUserData}`);
  }

  // NOTE: yet another way to delete responses
  for (const model of models.all()) {
    // @ts-expect-error -- TSCONVERSION optional type on response
    if (typeof model.hookDatabaseInit === 'function') {
      // @ts-expect-error -- TSCONVERSION optional type on response
      await model.hookDatabaseInit?.(consoleLog);
    }
  }
};
olddatabase.init = initDatabase;

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
    await olddatabase.flushChanges();
  }
}

// ~~~~~~~~~~~~~~~~~~~ //
// DEFAULT MODEL STUFF //
// ~~~~~~~~~~~~~~~~~~~ //

type Patch<T> = Partial<T>;

/**
 * Run various database repair scripts
 */
export async function _repairDatabase() {
  console.log('[fix] Running database repairs');

  for (const workspace of await olddatabase.find<Workspace>(models.workspace.type)) {
    await _repairBaseEnvironments(workspace);
    await _fixMultipleCookieJars(workspace);
    await _applyApiSpecName(workspace);
  }

  for (const gitRepository of await olddatabase.find<GitRepository>(models.gitRepository.type)) {
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
  const baseEnvironments = await olddatabase.find<Environment>(models.environment.type, {
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
    const subEnvironments = await olddatabase.find<Environment>(models.environment.type, {
      parentId: baseEnvironment._id,
    });

    for (const subEnvironment of subEnvironments) {
      await olddatabase.docUpdate(subEnvironment, {
        parentId: chosenBase._id,
      });
    }

    // Remove unnecessary base env
    await olddatabase.remove(baseEnvironment);
  }

  // Update remaining base env
  await olddatabase.update(chosenBase);
  console.log(`[fix] Merged ${baseEnvironments.length} base environments under ${workspace.name}`);
}

/**
 * This function repairs workspaces that have multiple cookie jars. Since a workspace
 * can only have one, this function walks over all jars and merges them and their cookies
 * together.
 */
async function _fixMultipleCookieJars(workspace: Workspace) {
  const cookieJars = await olddatabase.find<CookieJar>(models.cookieJar.type, {
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
    await olddatabase.remove(cookieJar);
  }

  // Update remaining jar
  await olddatabase.update(chosenJar);
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
  await olddatabase.update(doc);
  console.log(`[fix] Fixed git URI for ${doc._id}`);
}

export const database = process.type === 'renderer' ? window.db : olddatabase;
