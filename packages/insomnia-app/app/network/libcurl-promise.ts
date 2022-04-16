// NOTE: this file should not be imported by electron renderer because node-libcurl is not-context-aware
// Related issue https://github.com/JCMais/node-libcurl/issues/155
if (process.type === 'renderer') {
  throw new Error('node-libcurl unavailable in renderer');
}

import axios, { AxiosRequestConfig } from 'axios';
import electron from 'electron';
import fs from 'fs';
import https from 'https';
import mkdirp from 'mkdirp';
import path from 'path';
import { parse as urlParse } from 'url';
import { v4 as uuidv4 } from 'uuid';

import { version } from '../../config/config.json';
import { AUTH_AWS_IAM, AUTH_DIGEST, AUTH_NETRC, AUTH_NTLM, CONTENT_TYPE_FORM_DATA, CONTENT_TYPE_FORM_URLENCODED } from '../common/constants';
import { describeByteSize, hasAuthHeader, hasUserAgentHeader } from '../common/misc';
import { ClientCertificate } from '../models/client-certificate';
import { ResponseHeader } from '../models/response';
import { buildMultipart } from './multipart';
import { ResponsePatch } from './network';
import { parseHeaderStrings } from './parse-header-strings';

interface CurlRequestOptions {
  requestId: string; // for cancellation
  req: RequestUsedHere;
  finalUrl: string;
  settings: SettingsUsedHere;
  certificates: ClientCertificate[];
  fullCAPath: string;
  socketPath?: string;
  authHeader?: { name: string; value: string };
}
interface RequestUsedHere {
  headers: any;
  method: string;
  body: { mimeType?: string | null };
  authentication: Record<string, any>;
  settingFollowRedirects: string;
  settingRebuildPath: boolean;
  settingSendCookies: boolean;
  url: string;
  cookieJar: any;
  cookies: { name: string; value: string }[];
}
interface SettingsUsedHere {
  preferredHttpVersion: string;
  maxRedirects: number;
  proxyEnabled: boolean;
  timeout: number;
  validateSSL: boolean;
  followRedirects: boolean;
  maxTimelineDataSizeKB: number;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}
interface ResponseTimelineEntry {
  name: TimelineColors;
  timestamp: number;
  value: string;
}

interface CurlRequestOutput {
  patch: ResponsePatch;
  debugTimeline: ResponseTimelineEntry[];
  headerResults: HeaderResult[];
  responseBodyPath?: string;
}

const getDataDirectory = () => process.env.INSOMNIA_DATA_PATH || electron.app.getPath('userData');
// NOTE: this is a dictionary of functions to close open listeners
const cancelCurlRequestHandlers = {};
export const cancelCurlRequest = id => cancelCurlRequestHandlers[id]();
export const curlRequest = (options: CurlRequestOptions) => new Promise<CurlRequestOutput>(async resolve => {
  const responsesDir = path.join(getDataDirectory(), 'responses');
  mkdirp.sync(responsesDir);
  const responseBodyPath = path.join(responsesDir, uuidv4() + '.response');
  const requestBodyPath = await parseRequestBodyPath(options.req.body);
  const { method, body } = options.req;
  const requestBody = parseRequestBody({ body, method });
  let followRedirects = options.settings.followRedirects;
  if (options.req.settingFollowRedirects === 'off') {
    followRedirects = false;
  }
  if (options.req.settingFollowRedirects === 'on') {
    followRedirects = true;
  }
  const { protocol } = urlParse(options.finalUrl);
  const { httpProxy, httpsProxy } = options.settings;
  const proxyHost = protocol === 'https:' ? httpsProxy : httpProxy;
  const proxy = proxyHost ? setDefaultProtocol(proxyHost) : null;
  const { req, finalUrl, authHeader } = options;
  const headerStrings: string[] = parseHeaderStrings({ req, requestBody, requestBodyPath, finalUrl, authHeader });

  return resolve(axiosAdapter({ ...options, requestBodyPath, requestBody, responseBodyPath, followRedirects, protocol, proxy, headerStrings }));
});

const axiosAdapter = options => new Promise<CurlRequestOutput>(resolve => {
  const debugTimeline: ResponseTimelineEntry[] = [];

  try {
    const { requestId, req, requestBody, requestBodyPath, responseBodyPath, finalUrl, settings, certificates, fullCAPath, socketPath, authHeader, followRedirects, protocol, proxy, headerStrings } = options;
    const axiosOptions: AxiosRequestConfig = {
      url: finalUrl,
      method: req.method,
      headers: {},
      socketPath,
    };

    if (!settings.proxyEnabled) {
      axiosOptions.proxy = false;
    } else {
      if (settings.noProxy) {
        debugTimeline.push({ value: 'no_proxy is not supported by axios', name: 'TEXT', timestamp: Date.now() });
      }

      debugTimeline.push({ value: `Enable network proxy for ${protocol || ''}`, name: 'TEXT', timestamp: Date.now() });
      if (proxy) {
        const { hostname, port } = new URL(proxy);
        axiosOptions.proxy = {
          host: hostname,
          port: parseInt(port, 10),
        };
      }
    }

    const httpVersion = getHttpVersion(settings.preferredHttpVersion);
    debugTimeline.push({ value: httpVersion.log, name: 'TEXT', timestamp: Date.now() });

    if (httpVersion.curlHttpVersion) {
      debugTimeline.push({ value: 'HTTP version change not supported by axios', name: 'TEXT', timestamp: Date.now() });
    }

    const { validateSSL, maxRedirects } = settings;
    // // NOTE: disable follow redirects https://github.com/axios/axios/pull/307/files#diff-586c04c24
    if (followRedirects) {
      axiosOptions.maxRedirects = maxRedirects;
    } else {
      axiosOptions.maxRedirects = 0;
    }

    const agentConfig: https.AgentOptions = {
      rejectUnauthorized: validateSSL,
      ca: fullCAPath,
    };
    debugTimeline.push({ value: `${validateSSL ? 'Enable' : 'Disable'} SSL validation`, name: 'TEXT', timestamp: Date.now() });

    certificates.forEach(validCert => {
      const { passphrase, cert, key, pfx } = validCert;
      if (cert) {
        agentConfig.cert = cert;
        debugTimeline.push({ value: 'Adding SSL PEM certificate', name: 'TEXT', timestamp: Date.now() });
      }
      if (pfx) {
        agentConfig.pfx = pfx;
        debugTimeline.push({ value: 'Adding SSL P12 certificate', name: 'TEXT', timestamp: Date.now() });
      }
      if (key) {
        agentConfig.key = key;
        debugTimeline.push({ value: 'Adding SSL KEY certificate', name: 'TEXT', timestamp: Date.now() });
      }
      if (passphrase) {
        agentConfig.passphrase = passphrase;
      }
    });

    const { timeout } = settings;
    if (timeout <= 0) {
      axiosOptions.timeout = 0;
    } else {
      axiosOptions.timeout = timeout;
      debugTimeline.push({ value: `Enable timeout of ${timeout}ms`, name: 'TEXT', timestamp: Date.now() });
    }

    if (req.settingRebuildPath) {
      debugTimeline.push({ value: 'rebuild path is unsupported by axios', name: 'TEXT', timestamp: Date.now() });
    }

    if (requestBody) {
      axiosOptions.data = requestBody;
    }
    const isMultipart = req.body.mimeType === CONTENT_TYPE_FORM_DATA && requestBodyPath;
    let requestFileDescriptor;
    const { authentication } = req;
    if (requestBodyPath) {
      // AWS IAM file upload not supported
      if (authentication.type === AUTH_AWS_IAM) {
        throw new Error('AWS authentication not supported for provided body type');
      }
      // read file into request and close file descriptor
      requestFileDescriptor = fs.openSync(requestBodyPath, 'r');
      axiosOptions.data = fs.readFileSync(requestFileDescriptor, 'utf8');
      axiosOptions.maxBodyLength = 100 * 1024 * 1024; // 100 MB or Infinity? what do we intend to support? :shrug:
    }

    headerStrings.map(header => {
      if (header.includes(';')) {
        debugTimeline.push({ value: 'empty headers are not supported by axios?', name: 'TEXT', timestamp: Date.now() });
      }
      const [name, value] = header.split(':');
      // NOTE: skip empty header values
      if (value?.trim()) {
        axiosOptions.headers[name] = value?.trim();
      }
    });

    const { headers } = req;
    // Set User-Agent if it's not already in headers
    if (!hasUserAgentHeader(headers)) {
      axiosOptions.headers['User-Agent'] = `insomnia/${version}`;
    }

    const { disabled } = authentication;
    const isDigest = authentication.type === AUTH_DIGEST;
    const isNLTM = authentication.type === AUTH_NTLM;
    const isDigestOrNLTM = isDigest || isNLTM;
    if (!hasAuthHeader(headers) && !disabled && isDigestOrNLTM) {
      throw new Error('Digest and NTLM are not supported');
    }
    if (authentication.type === AUTH_NETRC) {
      throw new Error('NETRC is not supported');
    }

    if (req.settingSendCookies) {
      const { cookieJar, cookies } = req;
      if (cookies.length) {
        axiosOptions.headers['cookie'] = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
      }
      // set-cookies from previous redirects
      if (cookieJar.cookies.length) {
        debugTimeline.push({ value: 'set-cookies is unsupported', name: 'TEXT', timestamp: Date.now() });
      }
    }

    // cancel request by id map
    cancelCurlRequestHandlers[requestId] = () => {
      if (requestFileDescriptor) {
        closeReadFunction(requestFileDescriptor, isMultipart, requestBodyPath);
      }
    };

    axiosOptions.httpsAgent = new https.Agent(agentConfig);
    axiosOptions.adapter = require('axios/lib/adapters/http');
    axiosOptions.responseType = 'stream';
    axiosOptions.validateStatus = () => true;
    const startTime = performance.now();
    axios.request(axiosOptions)
      .then(({ data, status, statusText, headers, request }) => {
        debugTimeline.push({ value: `Found bundle for host ${request.host} (#1)`, name: 'TEXT', timestamp: Date.now() });
        debugTimeline.push({ value: `Connected to ${request.host} (#1)`, name: 'TEXT', timestamp: Date.now() });
        debugTimeline.push({ value: request._header, name: 'HEADER_OUT', timestamp: Date.now() });

        if (axiosOptions.data !== undefined) {
          if (requestBody) {
            debugTimeline.push({ value: axiosOptions.data, name: 'DATA_OUT', timestamp: Date.now() });
          }
          if (requestBodyPath) {
            debugTimeline.push({ value: 'file', name: 'DATA_OUT', timestamp: Date.now() });
          }
        }
        // // NOTE: axios chops HTTP/1.1 200 Success off the top of the raw header string
        debugTimeline.push({ value: `HTTP/${data.httpVersion} ${status} ${statusText}`, name: 'HEADER_IN', timestamp: Date.now() });
        Object.entries(data.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .map(h => debugTimeline.push({ value: h, name: 'HEADER_IN', timestamp: Date.now() }));
        let responseBodyBytes = 0;
        const responseBodyWriteStream = fs.createWriteStream(responseBodyPath);

        data.on('data', chunk => {
          responseBodyBytes += chunk.length;
          responseBodyWriteStream.write(chunk);
          debugTimeline.push({ value: `Received ${describeByteSize(chunk.length)} chunk`, name: 'DATA_IN', timestamp: Date.now() });

        });
        data.on('end', () => {
          responseBodyWriteStream.end();
          if (requestFileDescriptor) {
            closeReadFunction(requestFileDescriptor, isMultipart, requestBodyPath);
          }
          const rest = Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\n');
          const h = `HTTP/${data.httpVersion} ${status} ${statusText}
${rest}`;
          console.log('before', h);
          const headerResults = _parseHeaders(Buffer.from(h));
          debugTimeline.push({ value: `Connection #1 to host ${request.host} left intact`, name: 'TEXT', timestamp: Date.now() });
          const patch = {
            bytesContent: responseBodyBytes,
            bytesRead: responseBodyBytes, // should be different on cancel?
            elapsedTime: performance.now() - startTime,
            url: finalUrl,
          };
          resolve({ patch, debugTimeline, headerResults, responseBodyPath });

        });
      }).catch(e => {
        throw e;
      });
  } catch (e) {
    console.error(e);
    const patch = {
      statusMessage: 'Error',
      error: e.message || 'Something went wrong',
      elapsedTime: 0,
    };
    resolve({ patch, debugTimeline: [], headerResults: [{ version: '', code: 0, reason: '', headers: [] }] });
  }
});

const closeReadFunction = (fd: number, isMultipart: boolean, path?: string) => {
  fs.closeSync(fd);
  // NOTE: multipart files are combined before sending, so this file is deleted after
  // alt implemention to send one part at a time https://github.com/JCMais/node-libcurl/blob/develop/examples/04-multi.js
  if (isMultipart && path) {
    fs.unlink(path, () => { });
  }
};

// Because node-libcurl changed some names that we used in the timeline
type TimelineColors = 'HEADER_IN' | 'DATA_IN' | 'SSL_DATA_IN' | 'HEADER_OUT' | 'DATA_OUT' | 'SSL_DATA_OUT' | 'TEXT';

interface HeaderResult {
  headers: ResponseHeader[];
  version: string;
  code: number;
  reason: string;
}
export function _parseHeaders(buffer: Buffer): HeaderResult[] {
  // split on two new lines
  const redirects = buffer.toString('utf8').split(/\r?\n\r?\n|\r\r/g);
  return redirects.filter(r => !!r.trim()).map(redirect => {
    // split on one new line
    const [first, ...rest] = redirect.split(/\r?\n|\r/g);
    const headers = rest.map(l => l.split(/:\s(.+)/))
      .filter(([n]) => !!n)
      .map(([name, value = '']) => ({ name, value }));

    const [version, code, ...other] = first.split(/ +/g);
    return {
      version,
      code: parseInt(code, 10),
      reason: other.join(' '),
      headers,
    };
  });
}

const parseRequestBody = ({ body, method }) => {
  const isUrlEncodedForm = body.mimeType === CONTENT_TYPE_FORM_URLENCODED;
  const expectsBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
  const hasMimetypeAndUpdateMethod = typeof body.mimeType === 'string' || expectsBody;
  if (isUrlEncodedForm) {
    const urlSearchParams = new URLSearchParams();
    body.params.map(p => urlSearchParams.append(p.name, p?.value || ''));
    return urlSearchParams.toString();
  }
  if (hasMimetypeAndUpdateMethod) {
    return body.text;
  }
};
const parseRequestBodyPath = async body => {
  const isMultipartForm = body.mimeType === CONTENT_TYPE_FORM_DATA;
  if (!isMultipartForm) {
    return body.fileName;
  }
  const { filePath } = await buildMultipart(body.params || []);
  return filePath;
};

export const getHttpVersion = preferredHttpVersion => {
  switch (preferredHttpVersion) {
    case 'V1_0':
      return { log: 'Using HTTP 1.0', curlHttpVersion: preferredHttpVersion };
    case 'V1_1':
      return { log: 'Using HTTP 1.1', curlHttpVersion: preferredHttpVersion };
    case 'V2PriorKnowledge':
      return { log: 'Using HTTP/2 PriorKnowledge', curlHttpVersion: preferredHttpVersion };
    case 'V2_0':
      return { log: 'Using HTTP/2', curlHttpVersion: preferredHttpVersion };
    case 'v3':
      return { log: 'Using HTTP/3', curlHttpVersion: preferredHttpVersion };
    case 'default':
      return { log: 'Using default HTTP version' };
    default:
      return { log: `Unknown HTTP version specified ${preferredHttpVersion}` };
  }
};
export const setDefaultProtocol = (url: string, defaultProto?: string) => {
  const trimmedUrl = url.trim();
  defaultProto = defaultProto || 'http:';

  // If no url, don't bother returning anything
  if (!trimmedUrl) {
    return '';
  }

  // Default the proto if it doesn't exist
  if (trimmedUrl.indexOf('://') === -1) {
    return `${defaultProto}//${trimmedUrl}`;
  }

  return trimmedUrl;
};
