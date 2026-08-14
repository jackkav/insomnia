import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten';

import { Console } from '../../../insomnia-scripting-environment/src/objects/console';
import type { RequestContext } from '../../../insomnia-scripting-environment/src/objects/interfaces';
import { getQuickJSModule } from '../templating/sandbox/quickjs-runtime';

/**
 * The actual QuickJS execution engine — creates a fresh VM, bridges in the minimal API surface, runs
 * the script, and tears the VM down. Runs wherever it's called from (today: inside
 * `quickjs-script.worker.ts`, off the renderer's main thread — see `run-script-quickjs.ts` for the
 * client side of that boundary). Has no knowledge of workers/messaging; callers own that.
 *
 * PoC/experimental alternative to `run-script.ts`'s hidden-`BrowserWindow` execution path. Only a
 * minimal API surface is bridged in — enough to demonstrate the architecture, not enough to replace
 * the hidden-window sandbox yet. Gated behind `settings.useQuickJsScriptSandbox` (default off).
 *
 * insomnia.sendRequest() bridges to the real `network.sendRequestWithoutSideEffects` host handler
 * (the same one the template-tag sandbox uses) over the `insomnia-templating-worker-database://`
 * fetch-based protocol — see `installSendRequestBridge` below. It supports only a minimal request
 * shape (a URL string, or `{ url, method, headers, body }` with a plain string body) — no auth,
 * client certificates, cookies, or multipart/urlencoded bodies yet, and the response object exposes
 * only `code`/`status`/`headers`/`body`/`responseTime`/`json()`/`text()` (no chai assertions, no
 * `originalRequest`). Full parity with the hidden-window `Response` class is deferred.
 *
 * Async host work is owned by a `BridgeCalls` registry rather than by the individual callbacks that
 * start it (see below). That's what makes teardown deterministic: the VM is never disposed while a
 * host call still holds live VM handles, and a response that arrives after the run is over can't
 * touch a freed context.
 *
 * Not supported (throws inside the script if called): insomnia.test()/pm.test(), collectionVariables,
 * vault, cookies, client certificates, and mutating the request.
 */
export const runScriptInQuickJs = async ({
  script,
  context,
  authToken,
}: {
  script: string;
  context: RequestContext;
  /** Auth token for the `insomnia-templating-worker-database://` bridge — required for sendRequest. */
  authToken?: string;
}): Promise<RequestContext> => {
  const QuickJS = await getQuickJSModule();
  const vm = QuickJS.newContext();
  const scriptConsole = new Console();
  const timeoutMs = context.settings.timeout && context.settings.timeout > 0 ? context.settings.timeout : 30_000;
  const deadline = Date.now() + timeoutMs;

  // Copied in up front and mutated in place by the environment/variables bridges below; whatever
  // is left in these objects when the script finishes becomes the updated context.
  const environmentData: Record<string, unknown> = { ...context.environment.data };
  const variablesData: Record<string, unknown> = { ...context.transientVariables?.data };

  const bridgeCalls = createBridgeCalls();
  // Whether `__task` settled — gates whether teardown may pump the VM. See `abandonAll`.
  let taskSettled = false;

  try {
    // Polled during synchronous execution so a tight sync loop in the script can't bypass the timeout.
    vm.runtime.setInterruptHandler(() => Date.now() > deadline);
    vm.runtime.setMemoryLimit(32 * 1024 * 1024);

    installConsole(vm, scriptConsole);
    installKeyValueBridge(vm, '__envGet', '__envSet', environmentData);
    installKeyValueBridge(vm, '__varGet', '__varSet', variablesData);
    installSendRequestBridge(vm, bridgeCalls, authToken);
    setGlobalString(vm, '__requestJSON', JSON.stringify(context.request ?? {}));

    evalOrThrow(vm, BOOTSTRAP, '<quickjs-script-bootstrap>');
    evalOrThrow(vm, wrapUserScript(script), '<user-script>');

    await driveTaskToCompletion(vm, bridgeCalls, deadline, timeoutMs);
    taskSettled = true;
  } finally {
    // Nothing may still own a VM handle when the runtime goes — see `abandonAll`.
    bridgeCalls.abandonAll(vm, SEND_REQUEST_ABANDONED_MESSAGE, taskSettled);
    vm.dispose();
  }

  return {
    ...context,
    environment: {
      id: context.environment.id,
      name: context.environment.name,
      data: environmentData,
    },
    transientVariables: {
      name: context.transientVariables?.name || 'transientVariables',
      data: variablesData,
    },
    logs: scriptConsole.dumpLogsAsArray(),
  };
};

const unsupportedApiMessage = (name: string): string =>
  `${name} is not supported yet by the QuickJS sandbox (proof of concept). Disable "Use QuickJS sandbox for scripts" in Settings > Scripting to use it.`;

const BOOTSTRAP = `
globalThis.insomnia = {
  environment: {
    get: (key) => JSON.parse(__envGet(key)),
    set: (key, value) => { __envSet(key, JSON.stringify(value === undefined ? null : value)); },
  },
  variables: {
    get: (key) => JSON.parse(__varGet(key)),
    set: (key, value) => { __varSet(key, JSON.stringify(value === undefined ? null : value)); },
  },
  request: (function deepFreeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze);
      return Object.freeze(value);
    }
    return value;
  })(JSON.parse(__requestJSON)),
  sendRequest: (request, callback) => {
    const normalized = typeof request === 'string'
      ? { url: request, method: 'GET', headers: [] }
      : {
          url: request.url,
          method: request.method || 'GET',
          headers: Array.isArray(request.headers)
            ? request.headers
            : Object.entries(request.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
          body: request.body !== undefined ? { mimeType: 'text/plain', text: String(request.body) } : undefined,
        };
    const bodyJson = JSON.stringify({ options: { request: normalized, caCertficatePath: null } });
    const promise = __sendRequest(bodyJson).then((envelopeJson) => {
      const envelope = JSON.parse(envelopeJson);
      if (!envelope.ok) {
        throw new Error(envelope.error);
      }
      const result = envelope.value;
      return {
        code: result.code,
        status: result.status,
        headers: result.headers,
        body: result.body,
        responseTime: result.responseTime,
        json: () => JSON.parse(result.body),
        text: () => result.body,
      };
    });
    if (typeof callback === 'function') {
      promise.then(
        (response) => callback(undefined, response),
        (err) => callback(err.message),
      );
      return undefined;
    }
    return promise;
  },
  test: () => { throw new Error(${JSON.stringify(unsupportedApiMessage('insomnia.test()/pm.test()'))}); },
};
globalThis.$ = globalThis.insomnia;
`;

const wrapUserScript = (script: string): string => `
globalThis.__task = (async () => {
  ${script}
})();
`;

const installConsole = (vm: QuickJSContext, scriptConsole: Console): void => {
  const consoleHandle = vm.newObject();
  (['log', 'warn', 'error', 'info', 'debug'] as const).forEach(level => {
    const fn = vm.newFunction(level, (...argHandles: QuickJSHandle[]) => {
      const values = argHandles.map(handle => vm.dump(handle));
      scriptConsole[level](...values);
    });
    vm.setProp(consoleHandle, level, fn);
    fn.dispose();
  });
  vm.setProp(vm.global, 'console', consoleHandle);
  consoleHandle.dispose();
};

// Using one of these as a bracket-assignment key on a plain object rewires its prototype or
// shadows the name instead of setting an ordinary property.
const DANGEROUS_BRIDGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// The same fetch-based bridge the template-tag sandbox uses (`common/templating/liquid-extension-worker.ts`),
// reused here rather than adding a second protocol scheme — this endpoint already sends a real
// request via curl without persisting it to request/response history, which is exactly what an
// ad-hoc `insomnia.sendRequest()` call needs.
const SEND_REQUEST_ENDPOINT = 'insomnia-templating-worker-database://network.sendrequestwithoutsideeffects';
const TEMPLATING_DB_AUTH_HEADER = 'x-insomnia-templating-auth';

const SEND_REQUEST_ABANDONED_MESSAGE =
  'insomnia.sendRequest() did not finish before the script did — the request was cancelled.';

/** Settle/pump rounds allowed at teardown; the last one only settles. See `abandonAll`. */
const MAX_ABANDON_PASSES = 3;

const sendRequestViaFetch = async (
  requestBodyJson: string,
  signal: AbortSignal,
  authToken?: string,
): Promise<Record<string, unknown>> => {
  const resp = await fetch(SEND_REQUEST_ENDPOINT, {
    method: 'post',
    headers: authToken ? { [TEMPLATING_DB_AUTH_HEADER]: authToken } : undefined,
    body: requestBodyJson,
    signal,
  });
  const parsed = JSON.parse(await resp.text());
  if (!resp.ok) {
    throw new Error(typeof parsed?.error === 'string' ? parsed.error : `sendRequest failed with status ${resp.status}`);
  }
  return parsed;
};

/** One in-flight `insomnia.sendRequest()`: the VM promise the script is holding, plus its fetch. */
interface BridgeCall {
  deferred: QuickJSDeferredPromise;
  controller: AbortController;
}

type BridgeCalls = ReturnType<typeof createBridgeCalls>;

/**
 * Owns every `insomnia.sendRequest()` still waiting on the host.
 *
 * This registry exists because of how `vm.newPromise()` allocates: each deferred holds THREE
 * JSValues — the promise plus its `resolve`/`reject` functions — and quickjs-emscripten frees the
 * two functions only from inside `resolve()`/`reject()`. A deferred that is never settled therefore
 * keeps two live function objects in the runtime, and `JS_FreeRuntime` aborts the whole WASM module
 * on `assert(list_empty(&rt->gc_obj_list))` — a native Emscripten abort rather than a catchable
 * error, so it takes the script worker down instead of surfacing as a script failure.
 *
 * Rather than leave that invariant to each callback, the run owns the set: `driveTaskToCompletion`
 * drains it before finishing, and `abandonAll` guarantees it is empty before `vm.dispose()`.
 */
const createBridgeCalls = () => {
  const open = new Set<BridgeCall>();

  return {
    get size(): number {
      return open.size;
    },

    add(call: BridgeCall): void {
      open.add(call);
    },

    /** Called once a call has settled the VM promise itself; nothing left to clean up. */
    close(call: BridgeCall): void {
      open.delete(call);
    },

    /**
     * Cancel the host work for every call still open and settle its VM promise, so the run can
     * dispose the context safely. Rejecting is preferred over disposing the deferred outright: it
     * is the library's documented path, it frees the resolvers the same way, and a script that
     * attached a `.catch` (or passed a callback) gets a real error instead of a promise that
     * silently never settles. `dispose()` still runs afterwards as a backstop — it is idempotent,
     * and it is the thing that actually has to have happened before the runtime goes.
     *
     * `notifyScript` controls whether the VM job queue is pumped so the script's own `.catch` /
     * callback actually runs. It is only safe once `__task` has settled: pumping while the task is
     * still pending lets the rejection resume the script and settle the task, at which point
     * `vm.resolvePromise`'s reject callback `dup()`s the error into a host promise that
     * `driveTaskToCompletion` has already stopped listening to — an undisposed handle, i.e. the same
     * abort by another route. On the timeout/error path the deferreds are therefore freed silently.
     *
     * Passes alternate settle/pump because a script's handler can start another request; the last
     * pass never pumps, so nothing can be left unsettled behind us.
     */
    abandonAll(vm: QuickJSContext, reason: string, notifyScript: boolean): void {
      if (notifyScript && open.size > 0 && vm.alive) {
        // Teardown can run because the deadline passed, and an armed interrupt handler aborts the
        // pump below immediately — so the script would never see the cancellation. Nothing after
        // this point runs unbounded user code: the passes are capped.
        vm.runtime.removeInterruptHandler();
      }
      for (let pass = 0; pass < MAX_ABANDON_PASSES && open.size > 0; pass++) {
        const batch = [...open];
        open.clear();
        batch.forEach(({ deferred, controller }) => {
          controller.abort();
          if (vm.alive && deferred.alive) {
            const errorHandle = vm.newError(reason);
            deferred.reject(errorHandle);
            errorHandle.dispose();
          }
          deferred.dispose();
        });
        if (notifyScript && vm.alive && pass < MAX_ABANDON_PASSES - 1) {
          vm.runtime.executePendingJobs().dispose();
        }
      }
      open.clear();
    },
  };
};

/** Registers the async `__sendRequest(bodyJson)` bridge backing `insomnia.sendRequest()` in BOOTSTRAP. */
const installSendRequestBridge = (vm: QuickJSContext, calls: BridgeCalls, authToken?: string): void => {
  const fn = vm.newFunction('__sendRequest', bodyHandle => {
    const bodyJson = vm.getString(bodyHandle);
    const call: BridgeCall = { deferred: vm.newPromise(), controller: new AbortController() };
    calls.add(call);

    // `Promise.resolve().then(...)` defers the real fetch() call by one microtask tick so it never
    // runs while still nested inside this C-to-JS callback frame — matching plugin-tag-sandbox.ts's
    // installHostBridge, the proven-working equivalent for the template-tag sandbox.
    Promise.resolve()
      .then(() => sendRequestViaFetch(bodyJson, call.controller.signal, authToken))
      .then(
        value => settleCall(vm, calls, call, JSON.stringify({ ok: true, value })),
        err =>
          settleCall(
            vm,
            calls,
            call,
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          ),
      );

    // The settled VM promise schedules a job; pump it so the awaiting script resumes.
    call.deferred.settled.then(() => {
      if (vm.alive) {
        // executePendingJobs() returns a DisposableResult — on failure its `.error` is a live
        // QuickJSHandle that leaks if the result is discarded rather than disposed.
        vm.runtime.executePendingJobs().dispose();
      }
    });

    return call.deferred.handle;
  });
  setGlobal(vm, '__sendRequest', fn);
};

/**
 * Hand a host response back to the script, unless the run already abandoned this call.
 *
 * `abandonAll` settles and drops anything outstanding, so by the time a cancelled fetch rejects
 * here the deferred is dead and there is nothing to do. Touching a disposed context would throw
 * `QuickJSUseAfterFree` synchronously inside this `.then`, i.e. an unhandled rejection in the
 * worker, so both guards matter.
 */
const settleCall = (vm: QuickJSContext, calls: BridgeCalls, call: BridgeCall, value: string): void => {
  if (!vm.alive || !call.deferred.alive) {
    return;
  }
  const handle = vm.newString(value);
  call.deferred.resolve(handle);
  handle.dispose();
  calls.close(call);
};

/** Registers `<getName>(key)`/`<setName>(key, jsonValue)` host functions backed by a plain object. */
const installKeyValueBridge = (
  vm: QuickJSContext,
  getName: string,
  setName: string,
  store: Record<string, unknown>,
): void => {
  const getFn = vm.newFunction(getName, keyHandle => {
    const key = vm.getString(keyHandle);
    const value = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    return vm.newString(JSON.stringify(value));
  });
  setGlobal(vm, getName, getFn);

  const setFn = vm.newFunction(setName, (keyHandle, valueHandle) => {
    const key = vm.getString(keyHandle);
    if (DANGEROUS_BRIDGE_KEYS.has(key)) {
      return;
    }
    const rawValue = vm.getString(valueHandle);
    try {
      store[key] = JSON.parse(rawValue);
    } catch {
      store[key] = rawValue;
    }
  });
  setGlobal(vm, setName, setFn);
};

const setGlobal = (vm: QuickJSContext, name: string, handle: QuickJSHandle): void => {
  // setProp does NOT take ownership of handle — it must still be disposed here, or the VM leaks
  // it and asserts ("gc_obj_list" non-empty) when the runtime is later disposed.
  vm.setProp(vm.global, name, handle);
  handle.dispose();
};

const setGlobalString = (vm: QuickJSContext, name: string, value: string): void => {
  const handle = vm.newString(value);
  setGlobal(vm, name, handle);
};

const evalOrThrow = (vm: QuickJSContext, code: string, filename: string): void => {
  const result = vm.evalCode(code, filename);
  if (result.error) {
    const errData = vm.dump(result.error);
    result.error.dispose();
    throw toError(errData);
  }
  if ('value' in result) {
    result.value.dispose();
  }
};

/** Drives `globalThis.__task` (a VM promise wrapping the user script) to completion. */
const driveTaskToCompletion = async (
  vm: QuickJSContext,
  calls: BridgeCalls,
  deadline: number,
  timeoutMs: number,
): Promise<void> => {
  const taskHandle = vm.getProp(vm.global, '__task');
  const resultPromise = vm.resolvePromise(taskHandle);
  taskHandle.dispose();

  let settled: Awaited<typeof resultPromise> | undefined;
  resultPromise.then(result => {
    settled = result;
  });

  while (!settled) {
    // See installSendRequestBridge's identical call for why the result must be disposed, not
    // discarded: on failure its `.error` is a live QuickJSHandle that otherwise leaks.
    vm.runtime.executePendingJobs().dispose();
    if (settled) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`Executing script timeout: ${timeoutMs}`);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  if (settled.error) {
    const errData = vm.dump(settled.error);
    settled.error.dispose();
    throw toError(errData);
  }
  if ('value' in settled) {
    settled.value.dispose();
  }

  // The script can finish with requests still in flight — the Postman-style
  // `insomnia.sendRequest(url, callback)` form returns undefined, so a script using it reaches the
  // end of its body immediately. Returning here would tear the VM down before those responses
  // land, silently dropping every callback. Keep pumping until they arrive or the deadline passes;
  // whatever is left over is cancelled and rejected by `abandonAll`.
  while (calls.size > 0 && Date.now() <= deadline) {
    vm.runtime.executePendingJobs().dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

const toError = (data: unknown): Error => {
  if (data && typeof data === 'object' && 'message' in data) {
    const { message, name, stack } = data as { message?: string; name?: string; stack?: string };
    const err = new Error(message ?? 'QuickJS sandbox error');
    if (name) {
      err.name = name;
    }
    if (stack) {
      err.stack = stack;
    }
    return err;
  }
  return new Error(typeof data === 'string' ? data : JSON.stringify(data));
};
