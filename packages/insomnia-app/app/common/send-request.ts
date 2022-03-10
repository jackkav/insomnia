import { stats } from '../models';
import { getBodyBuffer } from '../models/response';
import { send } from '../network/network';
import * as plugins from '../plugins';

// The network layer uses settings from the settings model
// We want to give consumers the ability to override certain settings
export function getSendRequestCallback(environmentId?: string) {
  return async function sendRequest(requestId: string) {
    stats.incrementExecutedRequests();
    try {
      plugins.ignorePlugin('insomnia-plugin-kong-declarative-config');
      plugins.ignorePlugin('insomnia-plugin-kong-kubernetes-config');
      plugins.ignorePlugin('insomnia-plugin-kong-portal');
      const res = await send(requestId, environmentId);
      const headersObj: Record<string, string> = {};

      for (const h of res.headers || []) {
        const name = h.name || '';
        headersObj[name.toLowerCase()] = h.value || '';
      }

      const bodyBuffer = await getBodyBuffer(res) as Buffer;
      return {
        status: res.statusCode,
        statusMessage: res.statusMessage,
        data: bodyBuffer ? bodyBuffer.toString('utf8') : undefined,
        headers: headersObj,
        responseTime: res.elapsedTime,
      };
    } finally {
      plugins.clearIgnores();
    }
  };
}
