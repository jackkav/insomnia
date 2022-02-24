// assertion: ipc bridge cannot serialise functions so write and debug callbacks need to be simplified
// assertion: if logic like cancellation doesn't work we won't build it

// assumption: options are typechecked and don't need run time feedback.
// therefore we can build a list of options and apply them at once.

// assumption: settings timeline object can split into setup and debug timelines
// therefore I can just pass back what happened during debug to the respond function above

// overview: behaviours tightly coupled to node-libcurl implementation
// write response to file return path to file
// write debug output to timeline array
// getInfo time taken size and url
// expose a fire and forget close instance for cancel
// on error: close filewriter/s, close curl instance, save timeline return error message
// on end: close filewriter/s, close curl instance, set cookies, save timeline, return transformed headers, status

import { Curl, CurlCode, CurlFeature, CurlInfoDebug } from '@getinsomnia/node-libcurl';
import fs from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';
import uuid from 'uuid';

import { getDataDirectory } from '../common/electron-helpers';
import { describeByteSize, getContentTypeHeader } from '../common/misc';
import { ResponseHeader } from '../models/response';
import { ResponsePatch } from './network';
export const libCurlPromise = (options: Record<any, any>) => new Promise<ResponsePatch>(async resolve => {
  try {
    const curl = new Curl();
    // apply options to curl instance
    console.log(options);
    Object.entries(options).forEach(([k, v]) => curl.setOpt(k, v));
    // write response to file return path to file
    let responseBodyBytes = 0;
    const responsesDir = path.join(getDataDirectory(), 'responses');
    mkdirp.sync(responsesDir);
    const responseBodyPath = path.join(responsesDir, uuid.v4() + '.response');
    const responseBodyWriteStream = fs.createWriteStream(responseBodyPath);
    curl.setOpt(Curl.option.WRITEFUNCTION, buff => {
      responseBodyBytes += buff.length;
      responseBodyWriteStream.write(buff);
      return buff.length;
    });
    // Because node-libcurl changed some names that we used in the timeline
    const LIBCURL_DEBUG_MIGRATION_MAP = {
      HeaderIn: 'HEADER_IN',
      DataIn: 'DATA_IN',
      SslDataIn: 'SSL_DATA_IN',
      HeaderOut: 'HEADER_OUT',
      DataOut: 'DATA_OUT',
      SslDataOut: 'SSL_DATA_OUT',
      Text: 'TEXT',
      '': '',
    };
    const debugTimeline: any = [];
    // Setup debug handler
    curl.setOpt(Curl.option.DEBUGFUNCTION, (infoType, contentBuffer) => {
      const content = contentBuffer.toString('utf8');
      const rawName = Object.keys(CurlInfoDebug).find(k => CurlInfoDebug[k] === infoType) || '';
      const name = LIBCURL_DEBUG_MIGRATION_MAP[rawName] || rawName;

      if (infoType === CurlInfoDebug.SslDataIn || infoType === CurlInfoDebug.SslDataOut) {
        return 0;
      }

      // Ignore the possibly large data messages
      if (infoType === CurlInfoDebug.DataOut) {
        if (contentBuffer.length === 0) {
          return 0;
        }
        if (contentBuffer.length / 1024 < settings?.maxTimelineDataSizeKB || 10) {
          debugTimeline.push({
            name,
            value: content,
            timestamp: Date.now(),
          });
        } else {
          debugTimeline.push({
            name,
            value: `(${describeByteSize(contentBuffer.length)} hidden)`,
            timestamp: Date.now(),
          });
        }

        return 0;
      }

      if (infoType === CurlInfoDebug.DataIn) {
        debugTimeline.push({
          name: 'TEXT',
          value: `Received ${describeByteSize(contentBuffer.length)} chunk`,
          timestamp: Date.now(),
        });
        return 0;
      }

      // Don't show cookie setting because this will display every domain in the jar
      if (infoType === CurlInfoDebug.Text && content.indexOf('Added cookie') === 0) {
        return 0;
      }

      debugTimeline.push({
        name,
        value: content,
        timestamp: Date.now(),
      });
      return 0; // Must be here
    });

    curl.enable(CurlFeature.Raw); // makes rawHeaders a buffer, rather than HeaderInfo[]
    curl.on('end', async (_1, _2, rawHeaders: Buffer) => {
      const allCurlHeadersObjects = _parseHeaders(rawHeaders);
      console.log(allCurlHeadersObjects);

      // Headers are an array (one for each redirect)
      const lastCurlHeadersObject = allCurlHeadersObjects[allCurlHeadersObjects.length - 1];
      // Collect various things
      const httpVersion = lastCurlHeadersObject.version || '';
      const statusCode = lastCurlHeadersObject.code || -1;
      const statusMessage = lastCurlHeadersObject.reason || '';
      // Collect the headers
      const headers = lastCurlHeadersObject.headers;
      // Calculate the content type
      const contentTypeHeader = getContentTypeHeader(headers);
      const contentType = contentTypeHeader ? contentTypeHeader.value : '';
      // TODO: Update Cookie Jar, maybe outside of this because it touches db and cookieJar and debugTimeline
      resolve({
        debugTimeline,
        contentType,
        headers,
        httpVersion,
        statusCode,
        statusMessage,
        bodyPath: responseBodyPath,
        bytesContent: responseBodyBytes,
        // @ts-expect-error -- TSCONVERSION appears to be a genuine error
        bytesRead: curl.getInfo(Curl.info.SIZE_DOWNLOAD),
        elapsedTime: curl.getInfo(Curl.info.TOTAL_TIME) as number * 1000,
        // @ts-expect-error -- TSCONVERSION appears to be a genuine error
        url: curl.getInfo(Curl.info.EFFECTIVE_URL),
      });
    });
    curl.on('error', async function(err, code) {
      let error = err + '';
      let statusMessage = 'Error';

      if (code === CurlCode.CURLE_ABORTED_BY_CALLBACK) {
        error = 'Request aborted';
        statusMessage = 'Abort';
      }

      resolve({
        debugTimeline,
        statusMessage,
        error: error || 'Something went wrong',
        elapsedTime: curl.getInfo(Curl.info.TOTAL_TIME) as number * 1000,
      });
    });
    curl.perform();
  } catch (err) {
    console.log('[network] Error', err);
    resolve({
      debugTimeline,
      statusMessage: 'Error',
      error: err.message || 'Something went wrong',
      elapsedTime: 0, // 0 because this path is hit during plugin calls
    });
  }
});
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
