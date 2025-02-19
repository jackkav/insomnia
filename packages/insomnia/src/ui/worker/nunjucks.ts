// Create a new web worker
const worker = new Worker(new URL('./nunjucks-worker.ts', import.meta.url), { type: 'module' });

// Dispatch the job to the worker
export function renderInWorker({ input, context, path, ignoreUndefinedEnvVariable }: { input: string; context: Record<string, any>; path: string; ignoreUndefinedEnvVariable: boolean }): Promise<string> {
  worker.postMessage(JSON.stringify({ input, context, path, ignoreUndefinedEnvVariable }));
  return new Promise((resolve, reject) => {
    worker.onmessage = event => resolve(event.data);
    worker.onerror = event => {
      console.error('Error from worker:', event.message);
      reject();
    };
  });
}
