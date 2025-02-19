import * as templating from '../../templating';
const originalRequire = self.require;
const interceptor = (moduleName: string) => {
  const allowList = ['crypto', 'date-fns', 'fs', 'iconv-lite', 'jsonpath-plus', 'os', 'tough-cookie', 'uuid'];
  if (allowList.includes(moduleName)) {
    return originalRequire(moduleName);
  }
  throw new Error(`Cannot find module '${moduleName}'`);

};
async function performJob(input: { input: string; context: Record<string, any>; path: string; ignoreUndefinedEnvVariable: boolean }) {
  self.require = interceptor;
  return templating.render(input.input, { context: input.context, path: input.path, ignoreUndefinedEnvVariable: input.ignoreUndefinedEnvVariable });
}

// Listen for messages from the main thread
self.onmessage = async event => {
  const result = await performJob(JSON.parse(event.data));
  self.postMessage(result);
};
