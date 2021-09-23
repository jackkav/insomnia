import aws4 from 'aws4';
import clone from 'clone';
import crypto from 'crypto';
import fs from 'fs';
import mkdirp from 'mkdirp';
import { join as pathJoin } from 'path';
import { parse as urlParse } from 'url';

import {
  STATUS_CODE_PLUGIN_ERROR,
} from '../common/constants';
import { database as db } from '../common/database';
import { getDataDirectory } from '../common/electron-helpers';
import {
  delay,
  getContentTypeHeader,
  getHostHeader,
} from '../common/misc';
import type { ExtraRenderInfo, RenderedRequest } from '../common/render';
import {
  getRenderedRequestAndContext,
  RENDER_PURPOSE_NO_RENDER,
  RENDER_PURPOSE_SEND,
} from '../common/render';
import * as models from '../models';
import type { Environment } from '../models/environment';
import type { Request, RequestHeader } from '../models/request';
import type { ResponseHeader, ResponseTimelineEntry } from '../models/response';
import { isWorkspace } from '../models/workspace';
import * as pluginContexts from '../plugins/context/index';
import * as plugins from '../plugins/index';
import { cancelRequestById } from './curl';
import {
  _actuallySend,
} from './curl';

export interface ResponsePatch {
  bodyCompression?: 'zip' | null;
  bodyPath?: string;
  bytesContent?: number;
  bytesRead?: number;
  contentType?: string;
  elapsedTime: number;
  environmentId?: string | null;
  error?: string;
  headers?: ResponseHeader[];
  httpVersion?: string;
  message?: string;
  parentId?: string;
  settingSendCookies?: boolean;
  settingStoreCookies?: boolean;
  statusCode?: number;
  statusMessage?: string;
  timelinePath?: string;
  url?: string;
}

// Time since user's last keypress to wait before making the request
const MAX_DELAY_TIME = 1000;

let lastUserInteraction = Date.now();

export { cancelRequestById };

export async function sendWithSettings(
  requestId: string,
  requestPatch: Record<string, any>,
) {
  const request = await models.request.getById(requestId);

  if (!request) {
    throw new Error(`Failed to find request: ${requestId}`);
  }

  const settings = await models.settings.getOrCreate();
  const ancestors = await db.withAncestors(request, [
    models.request.type,
    models.requestGroup.type,
    models.workspace.type,
  ]);
  const workspaceDoc = ancestors.find(isWorkspace);
  const workspaceId = workspaceDoc ? workspaceDoc._id : 'n/a';
  const workspace = await models.workspace.getById(workspaceId);

  if (!workspace) {
    throw new Error(`Failed to find workspace for: ${requestId}`);
  }

  const workspaceMeta = await models.workspaceMeta.getOrCreateByParentId(workspace._id);
  const environmentId: string = workspaceMeta.activeEnvironmentId || 'n/a';
  const newRequest: Request = await models.initModel(models.request.type, requestPatch, {
    _id: request._id + '.other',
    parentId: request._id,
  });
  const environment: Environment | null = await models.environment.getById(environmentId || 'n/a');
  let renderResult: {
    request: RenderedRequest;
    context: Record<string, any>;
  };

  try {
    renderResult = await getRenderedRequestAndContext({ request: newRequest, environmentId });
  } catch (err) {
    throw new Error(`Failed to render request: ${requestId}`);
  }

  return _actuallySend(
    renderResult.request,
    renderResult.context,
    workspace,
    settings,
    environment,
    settings.validateAuthSSL,
  );
}

export async function send(
  requestId: string,
  environmentId?: string,
  extraInfo?: ExtraRenderInfo,
) {
  console.log(`[network] Sending req=${requestId} env=${environmentId || 'null'}`);
  // HACK: wait for all debounces to finish

  /*
   * TODO: Do this in a more robust way
   * The following block adds a "long" delay to let potential debounces and
   * database updates finish before making the request. This is done by tracking
   * the time of the user's last keypress and making sure the request is sent a
   * significant time after the last press.
   */
  const timeSinceLastInteraction = Date.now() - lastUserInteraction;
  const delayMillis = Math.max(0, MAX_DELAY_TIME - timeSinceLastInteraction);

  if (delayMillis > 0) {
    await delay(delayMillis);
  }

  // Fetch some things
  const request = await models.request.getById(requestId);
  const settings = await models.settings.getOrCreate();
  const ancestors = await db.withAncestors(request, [
    models.request.type,
    models.requestGroup.type,
    models.workspace.type,
  ]);

  if (!request) {
    throw new Error(`Failed to find request to send for ${requestId}`);
  }

  const environment: Environment | null = await models.environment.getById(environmentId || 'n/a');
  const renderResult = await getRenderedRequestAndContext(
    {
      request,
      environmentId,
      purpose: RENDER_PURPOSE_SEND,
      extraInfo,
    },
  );
  const renderedRequestBeforePlugins = renderResult.request;
  const renderedContextBeforePlugins = renderResult.context;
  const workspaceDoc = ancestors.find(isWorkspace);
  const workspace = await models.workspace.getById(workspaceDoc ? workspaceDoc._id : 'n/a');

  if (!workspace) {
    throw new Error(`Failed to find workspace for request: ${requestId}`);
  }

  let renderedRequest: RenderedRequest;

  try {
    renderedRequest = await _applyRequestPluginHooks(
      renderedRequestBeforePlugins,
      renderedContextBeforePlugins,
    );
  } catch (err) {
    return {
      environmentId: environmentId,
      error: err.message,
      parentId: renderedRequestBeforePlugins._id,
      settingSendCookies: renderedRequestBeforePlugins.settingSendCookies,
      settingStoreCookies: renderedRequestBeforePlugins.settingStoreCookies,
      statusCode: STATUS_CODE_PLUGIN_ERROR,
      statusMessage: err.plugin ? `Plugin ${err.plugin.name}` : 'Plugin',
      url: renderedRequestBeforePlugins.url,
    } as ResponsePatch;
  }

  const response = await _actuallySend(
    renderedRequest,
    renderedContextBeforePlugins,
    workspace,
    settings,
    environment,
    settings.validateSSL,
  );
  console.log(
    response.error
      ? `[network] Response failed req=${requestId} err=${response.error || 'n/a'}`
      : `[network] Response succeeded req=${requestId} status=${response.statusCode || '?'}`,
  );
  return response;
}

async function _applyRequestPluginHooks(
  renderedRequest: RenderedRequest,
  renderedContext: Record<string, any>,
) {
  const newRenderedRequest = clone(renderedRequest);

  for (const { plugin, hook } of await plugins.getRequestHooks()) {
    const context = {
      ...(pluginContexts.app.init(RENDER_PURPOSE_NO_RENDER) as Record<string, any>),
      ...pluginContexts.data.init(renderedContext.getProjectId()),
      ...(pluginContexts.store.init(plugin) as Record<string, any>),
      ...(pluginContexts.request.init(newRenderedRequest, renderedContext) as Record<string, any>),
      ...(pluginContexts.network.init(renderedContext.getEnvironmentId()) as Record<string, any>),
    };

    try {
      await hook(context);
    } catch (err) {
      err.plugin = plugin;
      throw err;
    }
  }

  return newRenderedRequest;
}

export async function _applyResponsePluginHooks(
  response: ResponsePatch,
  renderedRequest: RenderedRequest,
  renderedContext: Record<string, any>,
) {
  const newResponse = clone(response);
  const newRequest = clone(renderedRequest);

  for (const { plugin, hook } of await plugins.getResponseHooks()) {
    const context = {
      ...(pluginContexts.app.init(RENDER_PURPOSE_NO_RENDER) as Record<string, any>),
      ...pluginContexts.data.init(renderedContext.getProjectId()),
      ...(pluginContexts.store.init(plugin) as Record<string, any>),
      ...(pluginContexts.response.init(newResponse) as Record<string, any>),
      ...(pluginContexts.request.init(newRequest, renderedContext, true) as Record<string, any>),
      ...(pluginContexts.network.init(renderedContext.getEnvironmentId()) as Record<string, any>),
    };

    try {
      await hook(context);
    } catch (err) {
      err.plugin = plugin;
      throw err;
    }
  }

  return newResponse;
}

interface HeaderResult {
  headers: ResponseHeader[];
  version: string;
  code: number;
  reason: string;
}

export function _parseHeaders(
  buffer: Buffer,
) {
  const results: HeaderResult[] = [];
  const lines = buffer.toString('utf8').split(/\r?\n|\r/g);

  for (let i = 0, currentResult: HeaderResult | null = null; i < lines.length; i++) {
    const line = lines[i];
    const isEmptyLine = line.trim() === '';

    // If we hit an empty line, start parsing the next response
    if (isEmptyLine && currentResult) {
      results.push(currentResult);
      currentResult = null;
      continue;
    }

    if (!currentResult) {
      const [version, code, ...other] = line.split(/ +/g);
      currentResult = {
        version,
        code: parseInt(code, 10),
        reason: other.join(' '),
        headers: [],
      };
    } else {
      const [name, value] = line.split(/:\s(.+)/);
      const header: ResponseHeader = {
        name,
        value: value || '',
      };
      currentResult.headers.push(header);
    }
  }

  return results;
}

// exported for unit tests only
export function _getAwsAuthHeaders(
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  },
  headers: RequestHeader[],
  body: string,
  url: string,
  method: string,
  region?: string,
  service?: string,
): {
  name: string;
  value: string;
  description?: string;
  disabled?: boolean;
}[] {
  const parsedUrl = urlParse(url);
  const contentTypeHeader = getContentTypeHeader(headers);
  // AWS uses host header for signing so prioritize that if the user set it manually
  const hostHeader = getHostHeader(headers);
  const host = hostHeader ? hostHeader.value : parsedUrl.host;
  const awsSignOptions = {
    service,
    region,
    host,
    body,
    method,
    path: parsedUrl.path,
    headers: contentTypeHeader
      ? {
        'content-type': contentTypeHeader.value,
      }
      : {},
  };
  const signature = aws4.sign(awsSignOptions, credentials);
  return Object.keys(signature.headers)
    .filter(name => name !== 'content-type') // Don't add this because we already have it
    .map(name => ({
      name,
      value: signature.headers[name],
    }));
}

export function storeTimeline(timeline: ResponseTimelineEntry[]) {
  return new Promise<string>((resolve, reject) => {
    const timelineStr = JSON.stringify(timeline, null, '\t');
    const timelineHash = crypto.createHash('sha1').update(timelineStr).digest('hex');
    const responsesDir = pathJoin(getDataDirectory(), 'responses');
    mkdirp.sync(responsesDir);
    const timelinePath = pathJoin(responsesDir, timelineHash + '.timeline');
    fs.writeFile(timelinePath, timelineStr, err => {
      if (err != null) {
        reject(err);
      } else {
        resolve(timelinePath);
      }
    });
  });
}

if (global.document) {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    lastUserInteraction = Date.now();
  });
  document.addEventListener('paste', () => {
    lastUserInteraction = Date.now();
  });
}
