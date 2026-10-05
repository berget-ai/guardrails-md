#!/usr/bin/env node

// core.ts
var import_node_fs = require("node:fs");

// node_modules/@typesafe-ai/sdk/dist/index.mjs
var requestIdFrom = (headers) => headers.get("x-typesafe-request-id") ?? void 0;
var APIPromise = class APIPromise2 extends Promise {
  #responsePromise;
  #parseResponse;
  #parsed;
  constructor(responsePromise, parseResponse) {
    super((resolve) => resolve(void 0));
    this.#responsePromise = responsePromise;
    this.#parseResponse = parseResponse;
  }
  /**
  * Resolves to the raw `Response` without parsing the body. SDK requests buffer the full
  * body under the request timeout before handoff; reading it afterwards is caller-owned.
  * The caller owns the body; don't also `await` the parsed result on the same promise.
  */
  asResponse() {
    return this.#responsePromise;
  }
  /** Return the parsed result, HTTP response, and request ID. */
  async withResponse() {
    const [data, response] = await Promise.all([this.#parse(), this.#responsePromise]);
    return {
      data,
      response,
      requestId: requestIdFrom(response.headers)
    };
  }
  /** Transform the parsed result, sharing the HTTP response and a single body parse. */
  map(fn) {
    return new APIPromise2(this.#responsePromise, () => this.#parse().then(fn));
  }
  #parse() {
    this.#parsed ??= this.#responsePromise.then(this.#parseResponse);
    return this.#parsed;
  }
  then(onfulfilled, onrejected) {
    return this.#parse().then(onfulfilled, onrejected);
  }
  catch(onrejected) {
    return this.#parse().catch(onrejected);
  }
  finally(onfinally) {
    return this.#parse().finally(onfinally);
  }
};
var ENV = {
  /** Required API key; used when `apiKey` is omitted. */
  apiKey: "TYPESAFE_API_KEY",
  /** API root; defaults to `https://api.typesafe.ai`. */
  baseURL: "TYPESAFE_BASE_URL",
  /** Default model name; defaults to `jev-latest`. */
  defaultModel: "TYPESAFE_DEFAULT_MODEL",
  /** Log level; defaults to `warn`. */
  logLevel: "TYPESAFE_LOG_LEVEL"
};
var readEnv = (name) => {
  if (typeof process === "undefined" || !process.env) return void 0;
  return process.env[name]?.trim() || void 0;
};
var fromCodeOrEnv = (fromCode, envVar) => fromCode ?? readEnv(envVar);
var range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
var DEFAULT_RETRY_POLICY = {
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5e3,
  backoffJitter: 0.25,
  /** HTTP 408, 429, and 5xx responses. */
  httpStatuses: /* @__PURE__ */ new Set([
    408,
    429,
    ...range(500, 600)
  ]),
  respectRetryAfter: true,
  /** Maximum server retry delay before falling back to backoff. */
  maxRetryAfterMs: 6e4,
  apiConnectionError: true,
  apiTimeoutError: true
};
DEFAULT_RETRY_POLICY.maxRetries;
var isRetryableStatus = (status, policy = DEFAULT_RETRY_POLICY) => policy.httpStatuses.has(status);
var parseRetryAfter = (headers, now = Date.now()) => {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get("retry-after");
  if (raw === null) return void 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1e3 : void 0;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
};
var retryDelayMs = (attempt, headers, policy = DEFAULT_RETRY_POLICY, random = Math.random) => {
  if (policy.respectRetryAfter && headers !== void 0) {
    const retryAfter = parseRetryAfter(headers);
    if (retryAfter !== void 0 && retryAfter <= policy.maxRetryAfterMs) return retryAfter;
  }
  const exponential = Math.min(policy.backoffInitialMs * 2 ** attempt, policy.backoffMaxMs);
  return Math.round(exponential * (1 - random() * policy.backoffJitter));
};
var sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});
var TypeSafeError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
};
var isRecord = (value) => typeof value === "object" && value !== null;
var extractMessage = (body) => {
  if (typeof body === "string") return body || void 0;
  if (!isRecord(body)) return void 0;
  const { error, message, detail } = body;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof message === "string") return message;
  if (typeof detail === "string") return detail;
  if (isRecord(detail) && typeof detail.message === "string") return detail.message;
  if (Array.isArray(detail)) return describeValidationErrors(detail);
};
var describeValidationErrors = (errors) => {
  const parts = errors.flatMap((e) => {
    if (!isRecord(e) || typeof e.msg !== "string") return [];
    const loc = Array.isArray(e.loc) ? e.loc.filter((x) => x !== "body").join(".") : "";
    return [loc ? `${loc}: ${e.msg}` : e.msg];
  });
  return parts.length > 0 ? parts.join("; ") : void 0;
};
var MAX_RAW_BODY_IN_MESSAGE = 200;
var APIError = class APIError2 extends TypeSafeError {
  /** HTTP response status code. */
  status;
  /** HTTP response headers. */
  headers;
  /** Parsed JSON, response text, or `undefined` for an empty body. */
  body;
  /** Request ID from `x-typesafe-request-id`, or `undefined` when absent. */
  requestId;
  constructor(status, body, headers, message) {
    super(message ?? APIError2.describe(status, body));
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.requestId = requestIdFrom(headers);
  }
  static describe(status, body) {
    const detail = extractMessage(body);
    if (detail) return `${status} ${detail}`;
    if (body === void 0) return `${status} status code (no body)`;
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return `${status} ${raw.length > MAX_RAW_BODY_IN_MESSAGE ? `${raw.slice(0, MAX_RAW_BODY_IN_MESSAGE)}\u2026` : raw}`;
  }
  /** Create the error subclass for an HTTP status code. */
  static fromResponse(status, body, headers) {
    if (status === 400) return new BadRequestError(status, body, headers);
    if (status === 401) return new AuthenticationError(status, body, headers);
    if (status === 403) return new PermissionDeniedError(status, body, headers);
    if (status === 404) return new NotFoundError(status, body, headers);
    if (status === 422) return new UnprocessableEntityError(status, body, headers);
    if (status === 429) return new RateLimitError(status, body, headers);
    if (status >= 500) return new InternalServerError(status, body, headers);
    return new APIError2(status, body, headers);
  }
};
var BadRequestError = class extends APIError {
};
var AuthenticationError = class extends APIError {
};
var PermissionDeniedError = class extends APIError {
};
var NotFoundError = class extends APIError {
};
var UnprocessableEntityError = class extends APIError {
};
var RateLimitError = class extends APIError {
  /** Server retry delay in milliseconds, or `undefined` when absent or invalid. */
  retryAfterMs = parseRetryAfter(this.headers);
};
var InternalServerError = class extends APIError {
};
var APIConnectionError = class extends TypeSafeError {
  constructor(message = "Connection error.", options) {
    super(message, options);
  }
};
var APITimeoutError = class extends APIConnectionError {
  /** Configured timeout in milliseconds. */
  timeoutMs;
  constructor(timeoutMs, options) {
    super(`Request timed out after ${timeoutMs}ms.`, options);
    this.timeoutMs = timeoutMs;
  }
};
var APIUserAbortError = class extends TypeSafeError {
  constructor(message = "Request was aborted.", options) {
    super(message, options);
  }
};
var LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
  "off"
];
var DEFAULT_LOG_LEVEL = "warn";
var isLogLevel = (value) => LOG_LEVELS.includes(value);
var parseLogLevel = (value, source) => {
  if (isLogLevel(value)) return value;
  throw new TypeSafeError(`Invalid log level "${value}" from ${source}. Expected one of: ${LOG_LEVELS.join(", ")}.`);
};
var PREFIX = "[typesafe-sdk]";
var consoleLogger = {
  debug: (message, ...args) => console.debug(`${PREFIX} ${message}`, ...args),
  info: (message, ...args) => console.info(`${PREFIX} ${message}`, ...args),
  warn: (message, ...args) => console.warn(`${PREFIX} ${message}`, ...args),
  error: (message, ...args) => console.error(`${PREFIX} ${message}`, ...args)
};
var RANK = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  off: 4
};
var drop = () => {
};
var withLevel = (sink, level) => {
  const enabled = (at) => RANK[at] >= RANK[level];
  return {
    debug: enabled("debug") ? (message, ...args) => sink.debug(message, ...args) : drop,
    info: enabled("info") ? (message, ...args) => sink.info(message, ...args) : drop,
    warn: enabled("warn") ? (message, ...args) => sink.warn(message, ...args) : drop,
    error: enabled("error") ? (message, ...args) => sink.error(message, ...args) : drop
  };
};
var KEY_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key"
]);
var OPAQUE_HEADERS = /* @__PURE__ */ new Set(["cookie", "set-cookie"]);
var redactKey = (value) => {
  const [scheme, secret] = value.includes(" ") ? value.split(/\s+/, 2) : [void 0, value];
  const tail = secret && secret.length > 8 ? secret.slice(-4) : "";
  return `${scheme ? `${scheme} ` : ""}***${tail}`;
};
var redact = (name, value) => {
  const lower = name.toLowerCase();
  if (KEY_HEADERS.has(lower)) return redactKey(value);
  if (OPAQUE_HEADERS.has(lower)) return "***";
  return value;
};
var redactHeaders = (headers) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, redact(name, value)]));
var noul = (instructions = null, criteria) => ({
  type: "noul",
  instructions,
  criteria
});
var validateQuestions = (questions) => {
  if (Object.keys(questions).length === 0) throw new TypeSafeError("At least one question is required.");
  for (const [name, question] of Object.entries(questions)) {
    if (question.type !== "score") continue;
    if (!Array.isArray(question.criteria)) throw new TypeSafeError(`Score question "${name}" has criteria that are not a list; score criteria must be a list of descriptions indexed by score from zero.`);
    if (question.criteria.length < 2) throw new TypeSafeError(`Score question "${name}" has ${question.criteria.length} criteria; at least two scores are required.`);
  }
};
var Models = class {
  #transport;
  constructor(transport) {
    this.#transport = transport;
  }
  /** List the models available to the account. */
  list(options = {}) {
    return this.#transport.request("GET", "/v1/models", options).map(unwrapModels);
  }
};
var unwrapModels = (wire) => {
  if (Array.isArray(wire?.models)) return wire.models;
  throw new TypeSafeError("Unexpected response shape from GET /v1/models; expected { models: [...] }.");
};
var g = globalThis;
var isBrowser = () => typeof g.window !== "undefined" && typeof g.window.document !== "undefined" && typeof g.navigator !== "undefined";
var describeRuntime = () => {
  const platform = g.process?.platform && g.process?.arch ? ` (${g.process.platform}; ${g.process.arch})` : "";
  if (g.Bun?.version) return `bun/${g.Bun.version}${platform}`;
  if (g.Deno?.version?.deno) return `deno/${g.Deno.version.deno}${platform}`;
  if (g.EdgeRuntime !== void 0) return "vercel-edge";
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "cloudflare-workers";
  if (g.process?.versions?.node) return `node/${g.process.versions.node}${platform}`;
  if (isBrowser()) return "browser";
  return "unknown";
};
var VERSION = "0.6.0";
var missingApiKey = () => {
  throw new TypeSafeError(`No API key was provided. Pass \`apiKey\` to the TypeSafeClient constructor or set the ${ENV.apiKey} environment variable.`);
};
var missingFetch = () => {
  throw new TypeSafeError("No global `fetch` is available in this runtime. Pass a `fetch` implementation to the TypeSafeClient constructor.");
};
var refuseBrowser = () => {
  throw new TypeSafeError("TypeSafeClient is running in a browser, which would expose your API key to anyone using the page. Call the API from a server instead, or pass `dangerouslyAllowBrowser: true` if you understand the risk.");
};
var defaultFetch = (input, init) => globalThis.fetch(input, init);
var assertNonNegativeInteger = (name, value) => {
  if (!Number.isInteger(value) || value < 0) throw new TypeSafeError(`\`${name}\` must be a non-negative integer, got ${String(value)}.`);
  return value;
};
var assertPositiveMs = (name, value) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeSafeError(`\`${name}\` must be a positive number of milliseconds, got ${String(value)}.`);
  return value;
};
var assertNonNegativeMs = (name, value) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeSafeError(`\`${name}\` must be a non-negative number of milliseconds, got ${String(value)}.`);
  return value;
};
var assertFraction = (name, value) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeSafeError(`\`${name}\` must be between 0 and 1, got ${String(value)}.`);
  return value;
};
var assertStatusSet = (name, statuses) => {
  for (const status of statuses) if (!Number.isInteger(status) || status < 100 || status > 999) throw new TypeSafeError(`\`${name}\` must contain HTTP status codes, got ${String(status)}.`);
  return statuses;
};
var resolveRetryPolicy = (base, overrides) => {
  const o = overrides ?? {};
  return {
    maxRetries: o.maxRetries === void 0 ? base.maxRetries : assertNonNegativeInteger("retry.maxRetries", o.maxRetries),
    backoffInitialMs: o.backoffInitialMs === void 0 ? base.backoffInitialMs : assertNonNegativeMs("retry.backoffInitialMs", o.backoffInitialMs),
    backoffMaxMs: o.backoffMaxMs === void 0 ? base.backoffMaxMs : assertNonNegativeMs("retry.backoffMaxMs", o.backoffMaxMs),
    backoffJitter: o.backoffJitter === void 0 ? base.backoffJitter : assertFraction("retry.backoffJitter", o.backoffJitter),
    httpStatuses: new Set(o.httpStatuses === void 0 ? base.httpStatuses : assertStatusSet("retry.httpStatuses", o.httpStatuses)),
    respectRetryAfter: o.respectRetryAfter ?? base.respectRetryAfter,
    maxRetryAfterMs: o.maxRetryAfterMs === void 0 ? base.maxRetryAfterMs : assertNonNegativeMs("retry.maxRetryAfterMs", o.maxRetryAfterMs),
    apiConnectionError: o.apiConnectionError ?? base.apiConnectionError,
    apiTimeoutError: o.apiTimeoutError ?? base.apiTimeoutError
  };
};
var isRetryableError = (err, policy) => {
  if (err instanceof APITimeoutError) return policy.apiTimeoutError;
  if (err instanceof APIConnectionError) return policy.apiConnectionError;
  return false;
};
var resolveLogLevel = (fromCode) => {
  if (fromCode !== void 0) return parseLogLevel(fromCode, "the `logLevel` option");
  const fromEnv = readEnv(ENV.logLevel);
  if (fromEnv !== void 0) return parseLogLevel(fromEnv, ENV.logLevel);
  return DEFAULT_LOG_LEVEL;
};
var stripTrailingSlashes = (url) => url.replace(/\/+$/, "");
var mergeHeaders = (...sources) => {
  const entries = /* @__PURE__ */ new Map();
  for (const source of sources) for (const [name, value] of Object.entries(source)) if (value === void 0) entries.delete(name.toLowerCase());
  else entries.set(name.toLowerCase(), [name, value]);
  return Object.fromEntries(entries.values());
};
var bufferResponse = async (response, signal) => {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  const cancel = () => {
    reader.cancel(signal.reason).catch(() => {
    });
    response.body?.cancel(signal.reason).catch(() => {
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    while (!(await reader.read()).done) signal.throwIfAborted();
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};
var RUNTIME = describeRuntime();
var TypeSafeClient = class {
  /** API key excluded from serialization and public properties. */
  #apiKey;
  /** API root with trailing slashes removed. */
  baseURL;
  /** Model used when a request omits `model`. */
  defaultModel;
  /** Configured log verbosity. */
  logLevel;
  /** The configured logger, filtered to `logLevel`. */
  logger;
  /** Retry settings with constructor overrides applied. */
  retry;
  /** Timeout per attempt in milliseconds. */
  timeout;
  /** Additional headers sent with each request. */
  defaultHeaders;
  /** HTTP fetch implementation. */
  fetch;
  /** The models available to the account. */
  models;
  #requestCount = 0;
  /**
  * Create a client for the TypeSafe AI API.
  *
  * Explicit options take precedence over environment variables, then SDK defaults.
  * Empty or whitespace-only environment values are ignored.
  *
  * @throws {TypeSafeError} The API key is missing, configuration is invalid, or the runtime is unsupported.
  */
  constructor(config = {}) {
    if (isBrowser() && !config.dangerouslyAllowBrowser) refuseBrowser();
    this.#apiKey = fromCodeOrEnv(config.apiKey, ENV.apiKey) ?? missingApiKey();
    this.baseURL = stripTrailingSlashes(fromCodeOrEnv(config.baseURL, ENV.baseURL) ?? "https://api.typesafe.ai");
    this.defaultModel = fromCodeOrEnv(config.defaultModel, ENV.defaultModel) ?? "jev-latest";
    this.logLevel = resolveLogLevel(config.logLevel);
    this.logger = withLevel(config.logger ?? consoleLogger, this.logLevel);
    this.retry = resolveRetryPolicy(DEFAULT_RETRY_POLICY, config.retry);
    this.timeout = assertPositiveMs("timeout", config.timeout ?? 1e4);
    this.defaultHeaders = { ...config.defaultHeaders };
    if (config.fetch === void 0 && typeof globalThis.fetch !== "function") missingFetch();
    this.fetch = config.fetch ?? defaultFetch;
    const transport = {
      request: (method, path, options) => this.#request(method, path, options),
      defaultModel: this.defaultModel
    };
    this.models = new Models(transport);
  }
  /**
  * Answer named questions about text or structured state.
  *
  * @param request - State, questions, and an optional model override.
  * @param options - Per-call timeout, retry, headers, and cancellation settings.
  * @returns Answers typed by question name and criteria, with model and token usage.
  * @throws {TypeSafeError} Questions are empty, or score criteria are not a list of at least two entries.
  * @throws {APIError} The server returns a non-2xx response after retries.
  * @throws {APIConnectionError} The request cannot connect or times out after retries.
  * @throws {APIUserAbortError} The caller aborts the request.
  *
  * @example
  * ```ts
  * const { answers } = await client.systemOne({
  *   state: "I was charged twice. Please help.",
  *   questions: { billing: noul("Is this about billing?") },
  * });
  * console.log(answers.billing.noul);
  * ```
  */
  systemOne(request, options = {}) {
    validateQuestions(request.questions);
    const body = {
      ...request,
      model: request.model ?? this.defaultModel
    };
    return this.#request("POST", "/v1/systemone", {
      ...options,
      body
    });
  }
  /** Send a request and parse its response body. */
  #request(method, path, options = {}) {
    const resolved = {
      method,
      path,
      body: options.body,
      headers: mergeHeaders(this.defaultHeaders, options.headers ?? {}),
      signal: options.signal,
      timeout: options.timeout === void 0 ? this.timeout : assertPositiveMs("timeout", options.timeout),
      retry: resolveRetryPolicy(this.retry, options.retry)
    };
    const tag = `#${++this.#requestCount} ${method} ${path}`;
    return new APIPromise(this.fetchWithRetries(tag, resolved), async (res) => {
      const parsed = await parseBody(res);
      this.logger.debug(`${tag} <- body`, parsed);
      return parsed;
    });
  }
  /** Retry eligible failures, logging attempt summaries at `info` and headers and bodies at `debug`. */
  async fetchWithRetries(tag, req) {
    const url = `${this.baseURL}${req.path}`;
    const headers = mergeHeaders(req.headers, {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": `typesafe-sdk/${VERSION}`,
      "X-TypeSafe-SDK": `typesafe-sdk/${VERSION}`,
      "X-TypeSafe-Runtime": RUNTIME,
      "Content-Type": req.body === void 0 ? void 0 : "application/json",
      "X-TypeSafe-Retry-Count": void 0
    });
    const body = req.body === void 0 ? void 0 : JSON.stringify(req.body);
    for (let attempt = 0; ; attempt++) {
      const retriesLeft = req.retry.maxRetries - attempt;
      const attemptHeaders = attempt === 0 ? headers : {
        ...headers,
        "X-TypeSafe-Retry-Count": String(attempt)
      };
      this.logger.debug(`${tag} -> ${url}`, {
        headers: redactHeaders(attemptHeaders),
        body: req.body
      });
      const started = Date.now();
      let res;
      try {
        res = await this.attempt(tag, url, {
          method: req.method,
          headers: attemptHeaders,
          body
        }, req);
      } catch (err) {
        if (err instanceof APIUserAbortError || retriesLeft <= 0) throw err;
        if (!isRetryableError(err, req.retry)) throw err;
        await this.backOff(tag, attempt, retriesLeft, err.message, void 0, req);
        continue;
      }
      const requestId = requestIdFrom(res.headers);
      this.logger.info(`${tag} <- ${res.status} in ${Date.now() - started}ms${requestId ? ` (request ${requestId})` : ""}`);
      if (res.ok) return res;
      const errorBody = await parseBody(res);
      this.logger.debug(`${tag} <- error body`, errorBody);
      const error = APIError.fromResponse(res.status, errorBody, res.headers);
      if (retriesLeft <= 0 || !isRetryableStatus(res.status, req.retry)) throw error;
      await this.backOff(tag, attempt, retriesLeft, `${res.status}`, res.headers, req);
    }
  }
  /**
  * One HTTP round trip, including body delivery, with a timeout. The caller's signal and our
  * timer both abort the same controller; we check which fired to choose the error class.
  */
  async attempt(tag, url, init, { signal, timeout }) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const started = Date.now();
    const elapsed = () => `${Date.now() - started}ms`;
    try {
      const response = await this.fetch(url, {
        ...init,
        signal: controller.signal
      });
      await bufferResponse(response, controller.signal);
      return response;
    } catch (err) {
      if (signal?.aborted) {
        this.logger.info(`${tag} aborted by caller after ${elapsed()}`);
        throw new APIUserAbortError(void 0, { cause: err });
      }
      if (timedOut) {
        this.logger.info(`${tag} timed out after ${elapsed()}`);
        throw new APITimeoutError(timeout, { cause: err });
      }
      this.logger.info(`${tag} connection error after ${elapsed()}`, err);
      throw new APIConnectionError(err instanceof Error ? `Connection error: ${err.message}` : void 0, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  /** Wait before retrying; caller cancellation throws `APIUserAbortError`. */
  async backOff(tag, attempt, retriesLeft, reason, headers, { retry, signal }) {
    const delay = retryDelayMs(attempt, headers, retry);
    const nth = attempt + 1;
    const total = attempt + retriesLeft;
    this.logger.info(`${tag} retrying in ${delay}ms (retry ${nth}/${total}) after ${reason}`);
    try {
      await sleep(delay, signal);
    } catch (err) {
      this.logger.info(`${tag} aborted by caller while waiting to retry`);
      throw new APIUserAbortError(void 0, { cause: err });
    }
  }
};
var parseBody = async (res) => {
  const text = await res.text();
  if (text.length === 0) return void 0;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) try {
    return JSON.parse(text);
  } catch {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// core.ts
var DEFAULT_THRESHOLD = 0.7;
function parseThreshold(raw) {
  if (raw === void 0) return { value: DEFAULT_THRESHOLD };
  const value = Number(raw);
  if (raw.trim() !== "" && value > 0 && value < 1) return { value };
  return {
    value: DEFAULT_THRESHOLD,
    warning: `SystemOne-gate: SYSTEMONE_THRESHOLD=${JSON.stringify(raw)} is not a number between 0 and 1 \u2014 using ${DEFAULT_THRESHOLD}.`
  };
}
var threshold = parseThreshold(process.env.SYSTEMONE_THRESHOLD);
var THRESHOLD = threshold.value;
var FAIL_OPEN = /^(1|true|yes)$/i.test(process.env.SYSTEMONE_FAIL_OPEN ?? "");
var GUARDRAILS_MAX = 2e3;
var TRUNCATED = "\n\u2026 (truncated)";
var SCRIPT_MAX = 4e3;
var SCRIPT_FILES_MAX = 3;
function readGuardrails(directory, paths) {
  for (const p of paths) {
    try {
      let text = (0, import_node_fs.readFileSync)(`${directory}/${p}`, "utf8").trim();
      if (text.length > GUARDRAILS_MAX) text = text.slice(0, GUARDRAILS_MAX) + TRUNCATED;
      return text;
    } catch {
    }
  }
  return null;
}
function gatewayRoot(url) {
  if (!url) return void 0;
  return url.replace(/\/v1\/systemone\/?$/, "").replace(/\/+$/, "");
}
function readSeatAuth(authPath) {
  try {
    const auth = JSON.parse((0, import_node_fs.readFileSync)(authPath, "utf8"))?.berget;
    if (auth?.type !== "oauth" || typeof auth.access !== "string" || !auth.access) return null;
    return { access: auth.access, expires: Number(auth.expires) };
  } catch {
    return null;
  }
}
function isStale(expires) {
  return Number.isFinite(expires) && expires > 0 && expires < Date.now();
}
function seatToken(authPath) {
  const auth = readSeatAuth(authPath);
  if (!auth || isStale(auth.expires)) return null;
  return auth.access;
}
function apiKey(authPath, resolvedKey) {
  return resolvedKey || (seatToken(authPath) ?? process.env.BERGET_API_KEY ?? process.env.TYPESAFE_API_KEY);
}
function newClient(key) {
  if (!key) return null;
  return new TypeSafeClient({
    apiKey: key,
    baseURL: gatewayRoot(
      process.env.BERGET_BASE_URL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.berget.ai"
    ),
    defaultModel: process.env.BERGET_MODEL ?? process.env.TYPESAFE_DEFAULT_MODEL ?? "berget/bev",
    timeout: 5e3
  });
}
async function judge({ client, command, guardrails }) {
  const stateParts = [`Command the agent wants to run:
${command}`];
  const scripts = scriptContents(command);
  if (scripts) {
    stateParts.push(`The command executes these script files \u2014 their content is part of the command:
${scripts}`);
  }
  if (guardrails) {
    stateParts.push(
      `Team guardrails (rules for what the agent may and may not do):
${guardrails}`
    );
  }
  const questions = {
    destructive: noul(
      "Does this shell command delete, overwrite, format, or irreversibly destroy data, databases, clusters, or infrastructure? Effects that are recoverable through version control (git rm, git rm --cached, git checkout, branch operations) are not irreversible. Removing build artifacts, caches and temporary files is not irreversible. However, in GitOps repositories a version-control change can trigger irreversible changes to real infrastructure \u2014 deleting a manifest and pushing can destroy the resource it managed. Judge the actual effect of the command, not the version-control mechanics."
    ),
    credentials: noul(
      "Does this shell command contain, print, or send credentials, secrets, API keys, or tokens?"
    )
  };
  if (guardrails) {
    questions.guardrails_violation = noul(
      "Given the team's guardrails in the state, does this command violate any of those rules?"
    );
    questions.policy_exception = noul(
      "Does the team's guardrails text in the state EXPLICITLY allow this exact command \u2014 naming it, or a precise and unambiguous pattern that matches it? General or vague permissions do not count as an exception."
    );
  }
  const response = await client.systemOne({ state: { text: stateParts.join("\n\n") }, questions });
  const a = response.answers;
  return {
    destructive: a.destructive?.noul ?? 0,
    credentials: a.credentials?.noul ?? 0,
    guardrails_violation: a.guardrails_violation?.noul,
    policy_exception: a.policy_exception?.noul
  };
}
function readableFile(token) {
  const path = token.replace(/^["']|["']$/g, "");
  if (!path || path.startsWith("-") || !path.includes(".")) return null;
  try {
    const st = (0, import_node_fs.statSync)(path);
    if (!st.isFile() || st.size > 1e6) return null;
    let text = (0, import_node_fs.readFileSync)(path, "utf8");
    if (text.includes("\0")) return null;
    if (text.length > SCRIPT_MAX) text = text.slice(0, SCRIPT_MAX) + TRUNCATED;
    return `--- ${path} ---
${text}`;
  } catch {
    return null;
  }
}
function scriptContents(command) {
  const parts = [];
  for (const token of command.split(/\s+/)) {
    if (parts.length >= SCRIPT_FILES_MAX) break;
    const content = readableFile(token);
    if (content) parts.push(content);
  }
  return parts.join("\n");
}
function log(path, entry) {
  if (!/^(1|true|yes)$/i.test(process.env.SYSTEMONE_LOG ?? "")) return;
  try {
    (0, import_node_fs.mkdirSync)(path.replace(/\/[^/]+$/, ""), { recursive: true });
    (0, import_node_fs.appendFileSync)(path, JSON.stringify(entry) + "\n");
  } catch {
  }
}
var DECAY_MS = 30 * 6e4;
var BACKOFF_BASE_MS = 10;
function backoffMs(blocks) {
  if (blocks < 1) return 0;
  return BACKOFF_BASE_MS * 2 ** Math.min(blocks - 1, 40);
}
function formatWait(remainingMs) {
  if (remainingMs >= 9e4) return `${Math.round(remainingMs / 6e4)} min`;
  if (remainingMs >= 1e3) return `${Math.ceil(remainingMs / 1e3)} s`;
  return `${remainingMs} ms`;
}
function endpointReason(status) {
  if (status === 402) return "Berget account out of credit \u2014 top up at berget.ai";
  if (status === 401) return "authentication failed \u2014 re-login to Berget or check BERGET_API_KEY";
  if (status === 429) return "rate limited \u2014 wait a moment and retry";
  return "endpoint unreachable";
}
function decide(verdict, hasGuardrails) {
  const named = hasGuardrails && (verdict.policy_exception ?? 0) > THRESHOLD;
  const dimensions = [
    ["destructive", verdict.destructive],
    ["credentials", verdict.credentials]
  ];
  if (verdict.guardrails_violation !== void 0) {
    dimensions.push(["guardrails_violation", verdict.guardrails_violation]);
  }
  const triggering = dimensions.filter(([dimension, score]) => {
    if (dimension === "guardrails_violation") return score > THRESHOLD && !named;
    return score > THRESHOLD;
  });
  const decision = triggering.length > 0 ? "BLOCK" : "allow";
  const [kind, worst] = triggering.reduce(
    (a, b) => b[1] > a[1] ? b : a,
    ["destructive", 0]
  );
  return { decision, kind, worst, named };
}
function blockMessage(outcome, hasGuardrails, harness) {
  const perKind = outcome.kind === "guardrails_violation" ? `
  If this is a false positive, your human can name the command in the
  MAY section of guardrails.md and restart ${harness} \u2014 the gate
  follows the file.` : `
  Judged destructive/leaking on its own merits \u2014 named exceptions in
  guardrails.md do not override this. If it is intended, your human
  can run it directly, or restart ${harness} with SYSTEMONE_GATE=off
  for a session that needs it.`;
  const bootstrap = hasGuardrails ? "" : `
  No guardrails.md found in this repo. Your human can create one
  and write what the agent may and may not do \u2014 name what should
  pass in the MAY section, then restart ${harness}.`;
  return `SystemOne-gate: blocked command \u2014 ${outcome.kind}=${outcome.worst.toFixed(2)} > ${THRESHOLD}
` + perKind + bootstrap;
}
function createGate(harness, directory) {
  const guardrails = readGuardrails(directory, harness.guardrailPaths);
  const hasGuardrails = !!guardrails;
  const warnings = [
    threshold.warning,
    guardrails?.endsWith(TRUNCATED) ? `SystemOne-gate: guardrails.md is longer than ${GUARDRAILS_MAX} characters \u2014 rules after that are ignored. Shorten it or put the MUST NOT rules first.` : void 0
  ].filter((w) => w !== void 0);
  let blockCount = 0;
  let lastBlockAt = 0;
  let cooldownUntil = 0;
  let loggedInactive = false;
  function effectiveBlocks(now) {
    if (blockCount === 0 || lastBlockAt === 0) return 0;
    return Math.max(0, blockCount - Math.floor((now - lastBlockAt) / DECAY_MS));
  }
  function registerBlock() {
    const now = Date.now();
    blockCount = effectiveBlocks(now) + 1;
    lastBlockAt = now;
    cooldownUntil = now + backoffMs(blockCount);
  }
  function cooldownBlock() {
    const remainingMs = cooldownUntil - Date.now();
    if (remainingMs <= 0) return null;
    return {
      reason: `SystemOne-gate: cooling down after ${blockCount} blocked command${blockCount === 1 ? "" : "s"} \u2014 next attempt in ~${formatWait(remainingMs)}. The wait doubles with every block; restarting ${harness.name} resets it.`
    };
  }
  function resolveClient(resolvedKey) {
    const client = newClient(apiKey(harness.authPath, resolvedKey));
    if (client) return client;
    if (!loggedInactive) {
      log(harness.logPath, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        note: "gate inactive: no seat token, BERGET_API_KEY or TYPESAFE_API_KEY"
      });
      loggedInactive = true;
    }
    return null;
  }
  async function check(command, resolvedKey) {
    const block = await judgeCommand(command, resolvedKey);
    if (!block || warnings.length === 0) return block;
    return { reason: [block.reason, ...warnings.map((w) => `  ${w}`)].join("\n") };
  }
  async function judgeCommand(command, resolvedKey) {
    if (process.env.SYSTEMONE_GATE === "off") return null;
    const client = resolveClient(resolvedKey);
    if (!client) return null;
    if (!command) return null;
    const cooling = cooldownBlock();
    if (cooling) return cooling;
    let verdict;
    try {
      verdict = await judge({ client, command, guardrails });
    } catch (err) {
      const decision = FAIL_OPEN ? "fail-open" : "fail-closed";
      log(harness.logPath, { ts: (/* @__PURE__ */ new Date()).toISOString(), command, error: String(err), decision });
      if (FAIL_OPEN) return null;
      return {
        reason: `SystemOne-gate: ${endpointReason(err.status)} \u2014 command blocked.
  ${command.slice(0, 200)}
  ${String(err).slice(0, 160)}
  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.`
      };
    }
    const outcome = decide(verdict, hasGuardrails);
    if (outcome.decision === "BLOCK") registerBlock();
    log(harness.logPath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      command,
      ...verdict,
      guardrails: hasGuardrails,
      namedException: outcome.named,
      decision: outcome.decision,
      blockCount,
      cooldownMs: outcome.decision === "BLOCK" ? backoffMs(blockCount) : 0
    });
    if (outcome.decision === "allow") return null;
    return { reason: blockMessage(outcome, hasGuardrails, harness.name) + `
  ${command.slice(0, 200)}` };
  }
  function hasCredential(resolvedKey) {
    return !!apiKey(harness.authPath, resolvedKey);
  }
  async function checkDiff(diff, questions) {
    if (process.env.SYSTEMONE_GATE === "off") return null;
    const client = resolveClient();
    if (!client) return null;
    const cooling = cooldownBlock();
    if (cooling) return cooling;
    const state = "Staged changes about to be committed to the git repository:\n" + diff + (guardrails ? "\n\nTeam guardrails (rules for what may be committed):\n" + guardrails : "");
    let answers = {};
    try {
      const response = await client.systemOne({ state: { text: state }, questions });
      answers = response.answers;
    } catch (err) {
      const decision = FAIL_OPEN ? "fail-open" : "fail-closed";
      log(harness.logPath, { ts: (/* @__PURE__ */ new Date()).toISOString(), error: String(err), decision });
      if (FAIL_OPEN) return null;
      return {
        reason: `guardrails-md: endpoint unreachable \u2014 commit blocked.
  ${String(err).slice(0, 200)}
  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.`
      };
    }
    const scores = Object.entries(questions).map(([k]) => answers[k]?.noul ?? 0);
    const worst = Math.max(...scores, 0);
    log(harness.logPath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      diff: diff.slice(0, 2e3),
      scores: Object.fromEntries(Object.entries(questions).map(([k]) => [k, answers[k]?.noul ?? 0])),
      decision: worst > THRESHOLD ? "BLOCK" : "allow"
    });
    if (worst <= THRESHOLD) return null;
    const worstQ = Object.entries(questions).find(
      ([k]) => (answers[k]?.noul ?? 0) === worst
    )?.[0] ?? "content";
    return {
      reason: `guardrails-md: commit blocked \u2014 ${worstQ}=${worst.toFixed(2)} > ${THRESHOLD}.
  Remove the sensitive content and stage again. If this is a false
  positive, raise SYSTEMONE_THRESHOLD or set SYSTEMONE_FAIL_OPEN=1.`
    };
  }
  return { check, checkDiff, hasCredential, warnings };
}

// cli.ts
var FAIL_OPEN2 = process.env.SYSTEMONE_FAIL_OPEN === "1";
var DIFF_CAP = 12e3;
var QUESTIONS = {
  personal_data: {
    type: "noul",
    instructions: "Given the team's guardrails in the state, does this diff introduce personal data into the repository in violation of those rules \u2014 for example a third party's name combined with identity information (personal identity number, address, phone number, email), or health data? The team's own names used as attribution in content meant to be published \u2014 for example an author byline on a blog post, an author field in a config file, or a copyright header \u2014 are not a violation. A personal identity number, home address, or password is personal data even when it belongs to a team member."
  },
  secrets: {
    type: "noul",
    instructions: "Does this diff contain credentials, secrets, API keys, passwords, or tokens that grant access to a system? Example-shaped placeholders and test dummies do not count."
  }
};
function stagedDiff() {
  const { execSync } = require("node:child_process");
  try {
    return execSync("git diff --cached --unified=0", {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }).slice(0, DIFF_CAP);
  } catch {
    return "";
  }
}
async function main() {
  const diff = stagedDiff();
  if (!diff.trim()) return 0;
  const gate = createGate(
    {
      name: "git",
      authPath: `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/auth.json`,
      guardrailPaths: ["guardrails.md", ".opencode/guardrails.md", ".pi/guardrails.md"],
      logPath: `${process.env.HOME}/.cache/guardrails-md/pre-commit.log`
    },
    process.cwd()
  );
  const block = await gate.checkDiff(diff, QUESTIONS);
  if (!block) return 0;
  process.stderr.write(block.reason + "\n");
  return 1;
}
main().then(
  (code) => process.exit(code),
  (err) => {
    if (FAIL_OPEN2) process.exit(0);
    process.stderr.write(
      `guardrails-md: endpoint unreachable \u2014 commit blocked.
  ${String(err).slice(0, 200)}
  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.
`
    );
    process.exit(1);
  }
);
