/**
 * tests/helpers/serverHelper.js
 *
 * Shared test utilities and constants for the server.js test suite.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   - Spawn-based lifecycle test orchestration helpers (`spawnServer`,
 *     `waitForListening`, `killAndWait`)
 *   - A handler-replication factory (`createEquivalentHandler`) that
 *     recreates server.js's inline request listener for in-process
 *     Supertest assertions WITHOUT requiring server.js (which would
 *     immediately bind 127.0.0.1:3000 on require).
 *   - Expected-value constants for byte-exact assertion targets
 *     (`EXPECTED_BODY`, `EXPECTED_CONTENT_TYPE`, `EXPECTED_STARTUP_LOG`).
 *   - Test-matrix arrays for parameterized unit tests
 *     (`HTTP_METHODS`, `URL_PATHS`).
 *
 * Architectural Constraints (per AAP Section 0.10.1):
 *   - CommonJS only (`require()` and `module.exports`) to match server.js
 *   - 2-space indentation, single-quote string literals, trailing semicolons
 *   - No `'use strict'` directive (server.js does not use one)
 *   - No side effects on require: no port binding, no global mutation,
 *     no child-process spawn, no `process.on(...)` registration
 *   - No describe/it/test/expect calls — this is a utility module, NOT a test
 *   - No Jest or Supertest imports — this module is consumed BY test files
 *   - DO NOT import server.js (it would call `server.listen(3000, ...)`
 *     synchronously on require, polluting the test runner process)
 *
 * @see AAP Section 0.4.4 — Test Data and Fixtures Design
 * @see AAP Section 0.5.1 — File-by-File Test Plan (row 7)
 * @see AAP Section 0.5.2 — New Test Files Detail
 * @see AAP Section 0.5.5 — Cross-File Test Dependencies
 * @see AAP Section 0.10.1 — Testability Without Source Modification
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

/**
 * Absolute filesystem path to the subject server.js at the repository root.
 *
 * Resolution: `tests/helpers/serverHelper.js` → `..` (tests/) → `..`
 * (repository root) → `server.js`. Using `path.resolve` produces an
 * OS-appropriate absolute path (forward slashes on POSIX, backslashes on
 * Windows). The `child_process.spawn` call below uses this path as the
 * argument to `node`, ensuring the spawned process executes the exact
 * subject file (and not one of the byte-equivalent variant files such as
 * `Test.test..js`, `!@#$%^&().js`, or the long-named server file).
 *
 * @type {string}
 */
const SERVER_JS_PATH = path.resolve(__dirname, '..', '..', 'server.js');

/**
 * Absolute filesystem path to the repository root, used as the working
 * directory (`cwd`) of the spawned child process. Setting `cwd` to the
 * repository root ensures any relative paths within server.js (currently
 * none) would resolve correctly, and provides a deterministic working
 * directory regardless of where Jest was invoked from.
 *
 * @type {string}
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Expected-Value Constants (Single Source of Truth)
// ---------------------------------------------------------------------------

/**
 * Exact 14-byte response body produced by server.js:9
 * (`res.end('Hello, World!\n');`). The trailing newline is critical —
 * tests assert byte-level equality including the `\n` to verify the
 * server emits the correct payload format.
 *
 * Byte breakdown:
 *   'H' 'e' 'l' 'l' 'o' ',' ' ' 'W' 'o' 'r' 'l' 'd' '!' '\n'
 *    0   1   2   3   4   5   6   7   8   9  10  11  12  13  → 14 bytes
 *
 * @type {string}
 */
const EXPECTED_BODY = 'Hello, World!\n';

/**
 * Exact response Content-Type header value set by server.js:8
 * (`res.setHeader('Content-Type', 'text/plain');`). Note: this is the
 * RAW value as set; Node.js does NOT auto-append a charset parameter
 * for `setHeader` (unlike Express, which would produce
 * `text/plain; charset=utf-8`). Tests must assert against this exact
 * string, not a regex with optional parameters.
 *
 * @type {string}
 */
const EXPECTED_CONTENT_TYPE = 'text/plain';

/**
 * Exact resolved-template-literal output of server.js:13
 * (`console.log(\`Server running at http://${hostname}:${port}/\`);`).
 * With hostname='127.0.0.1' (server.js:3) and port=3000 (server.js:4),
 * the template literal evaluates to this constant string.
 *
 * Used by `waitForListening` as a substring search target on the
 * spawned child process's stdout buffer.
 *
 * @type {string}
 */
const EXPECTED_STARTUP_LOG = 'Server running at http://127.0.0.1:3000/';

// ---------------------------------------------------------------------------
// Test-Matrix Constants
// ---------------------------------------------------------------------------

/**
 * The seven primary HTTP methods exercised by parameterized tests in
 * `tests/unit/server.statusCode.test.js` and
 * `tests/unit/server.edgeCases.test.js`.
 *
 * server.js performs no method discrimination — its inline handler runs
 * unconditionally for every incoming request — so all seven methods
 * MUST produce identical 200 OK responses (modulo HTTP-protocol-mandated
 * behavior such as HEAD returning empty body).
 *
 * @type {ReadonlyArray<string>}
 */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/**
 * URL path matrix for edge-case parameterized tests. Covers:
 *   - Root path ('/')
 *   - Simple sub-path ('/hello')
 *   - Multi-segment path ('/api/v1/test')
 *   - Path with query string ('/path?query=value')
 *   - Path with URL-encoded special characters ('/path%20with%20spaces')
 *
 * server.js performs no path discrimination — its inline handler runs
 * unconditionally for every incoming request — so all paths MUST produce
 * identical 200 OK responses with the same body.
 *
 * @type {ReadonlyArray<string>}
 */
const URL_PATHS = ['/', '/hello', '/api/v1/test', '/path?query=value', '/path%20with%20spaces'];

// ---------------------------------------------------------------------------
// spawnServer — Out-of-process server orchestration
// ---------------------------------------------------------------------------

/**
 * Spawn the actual server.js as a child Node.js process.
 *
 * The spawned process runs `node <SERVER_JS_PATH>` with stdin ignored and
 * stdout/stderr piped into accumulator buffers exposed via the returned
 * `stdout` and `stderr` objects. Each buffer object has a `.content`
 * string property that is mutated (not reassigned) as data arrives — this
 * stable-reference pattern lets `waitForListening` and post-test
 * assertions inspect the live captured output.
 *
 * The child process inherits `process.env` augmented with any keys passed
 * via `options.env`. The child's working directory is the repository root
 * (`REPO_ROOT`) so server.js executes in the same context as a manual
 * `node server.js` invocation from the repo root.
 *
 * IMPORTANT: This function does NOT await server startup. Callers must
 * use `waitForListening(stdout, timeoutMs)` to await the binding/log
 * emission before issuing requests against the spawned server.
 *
 * @param {Object} [options] - Spawn options.
 * @param {Object} [options.env] - Extra environment variables merged
 *   into the child's `process.env`. Defaults to `{}` (no overrides).
 * @param {number} [options.port] - Documentation-only field. server.js
 *   hard-codes port 3000 and does NOT read any environment variable for
 *   port configuration; passing this value has no effect on binding.
 *   Documented for future-compatibility if server.js is ever modified.
 * @returns {{ child: import('child_process').ChildProcess,
 *             stdout: { content: string },
 *             stderr: { content: string } }}
 *   An object containing:
 *     - `child`: the ChildProcess handle (pid, kill, exitCode, etc.)
 *     - `stdout`: { content: string } accumulator that mirrors stdout
 *     - `stderr`: { content: string } accumulator that mirrors stderr
 */
function spawnServer(options = {}) {
  const env = options && options.env ? options.env : {};
  // The `port` option is documentation-only (server.js hard-codes port 3000).
  // Reference it explicitly so static analyzers do not flag the destructure
  // as unused; the void operator ensures no observable side effect.
  void (options && options.port);

  const child = spawn('node', [SERVER_JS_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = { content: '' };
  const stderr = { content: '' };

  // Append-on-data accumulators. Decoded as UTF-8 because server.js's
  // startup log (`Server running at http://127.0.0.1:3000/`) is pure
  // ASCII (a UTF-8 subset) and Node.js error messages such as
  // `EADDRINUSE` are also UTF-8 / ASCII.
  child.stdout.on('data', (chunk) => {
    stdout.content += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr.content += chunk.toString('utf8');
  });

  return { child, stdout, stderr };
}

// ---------------------------------------------------------------------------
// waitForListening — Async readiness gate
// ---------------------------------------------------------------------------

/**
 * Returns a Promise that resolves when the spawned server emits its
 * startup log to stdout, or rejects on timeout.
 *
 * Implementation: First synchronously checks if `stdout.content` already
 * contains the startup log substring (handling the race where the
 * `'data'` event fired before the caller awaited this promise). If not
 * yet present, polls every 50ms until either the substring appears
 * (resolves) or `timeoutMs` elapses (rejects with a descriptive error
 * containing the captured-so-far stdout for debugging).
 *
 * The polling cadence (50ms) yields ~100 checks across the default
 * 5000ms timeout — light CPU overhead with sub-100ms detection latency.
 *
 * @param {{ content: string }} stdout - The stdout accumulator returned
 *   by `spawnServer`. Must have a `.content` string property.
 * @param {number} [timeoutMs=5000] - Maximum time in milliseconds to
 *   wait for the startup log before rejecting. Default 5 seconds per
 *   AAP Section 0.10.1 startup-log timeout guidance.
 * @returns {Promise<void>} Resolves with no value on detection;
 *   rejects with a descriptive Error on timeout.
 */
function waitForListening(stdout, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (stdout && typeof stdout.content === 'string' && stdout.content.includes(EXPECTED_STARTUP_LOG)) {
      resolve();
      return;
    }

    const startTime = Date.now();
    const interval = setInterval(() => {
      if (stdout && typeof stdout.content === 'string' && stdout.content.includes(EXPECTED_STARTUP_LOG)) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startTime >= timeoutMs) {
        clearInterval(interval);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for startup log "${EXPECTED_STARTUP_LOG}". ` +
              `Captured stdout so far: ${JSON.stringify(stdout && stdout.content)}`
          )
        );
      }
    }, 50);
  });
}

// ---------------------------------------------------------------------------
// killAndWait — Graceful child-process termination
// ---------------------------------------------------------------------------

/**
 * Send a signal to the child process and await its exit.
 *
 * If the child has already exited (either `child.exitCode !== null` or
 * `child.signalCode !== null`), resolves IMMEDIATELY with the captured
 * exit metadata — avoiding a hang on tests that previously observed
 * the exit independently.
 *
 * Otherwise, registers a one-time `'exit'` listener (using `.once` to
 * prevent listener leaks across repeated invocations), starts a timeout
 * that rejects after `timeoutMs`, and then sends `signal` via
 * `child.kill(signal)`. Synchronous errors from `child.kill` (e.g.,
 * invalid signal name) are caught and propagated as a Promise rejection.
 *
 * Both resolve and reject paths clear the timeout to prevent dangling
 * timer handles that could keep the Node.js event loop alive.
 *
 * Platform Note: On POSIX systems (Linux, macOS), a SIGTERM-killed
 * Node.js process exits with `exitCode === null` and
 * `signal === 'SIGTERM'` (since server.js installs no SIGTERM handler).
 * On Windows, Node.js translates POSIX signal names appropriately. Tests
 * should accept either `(null, 'SIGTERM')` or `(0, null)` patterns to be
 * cross-platform robust.
 *
 * @param {import('child_process').ChildProcess} child - The ChildProcess
 *   instance returned by `spawnServer().child`.
 * @param {string} [signal='SIGTERM'] - The OS signal name to send.
 *   Defaults to SIGTERM (graceful termination).
 * @param {number} [timeoutMs=5000] - Maximum time in milliseconds to
 *   wait for child exit before rejecting. Default 5 seconds.
 * @returns {Promise<{ exitCode: number|null, signal: string|null }>}
 *   Resolves with the child's `exitCode` (numeric exit code or null)
 *   and `signal` (signal name or null) on exit; rejects on timeout
 *   or kill error.
 */
function killAndWait(child, signal = 'SIGTERM', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // Short-circuit: child already exited before this call — return
    // its captured exit metadata without sending any signal.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exitCode: child.exitCode, signal: child.signalCode });
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error(`Child process did not exit within ${timeoutMs}ms after ${signal}`));
    }, timeoutMs);

    // Use `.once` (not `.on`) to prevent listener accumulation if this
    // helper is called multiple times against the same child.
    child.once('exit', (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal: exitSignal });
    });

    try {
      child.kill(signal);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// createEquivalentHandler — In-process Supertest target
// ---------------------------------------------------------------------------

/**
 * Construct a fresh `http.Server` instance whose request listener is
 * BYTE-EQUIVALENT to the inline handler at server.js:6-10.
 *
 * The returned server is NOT listening on any port — it is intended to
 * be passed directly to Supertest (`request(server)`), which binds the
 * server to an OS-assigned ephemeral port for the duration of each
 * test request. Each invocation returns a freshly-created server to
 * guarantee per-test isolation.
 *
 * Why reconstruction instead of importing server.js?
 *   server.js calls `server.listen(3000, '127.0.0.1', ...)` at the
 *   top level (line 12), which means `require('../../server.js')`
 *   would synchronously bind 127.0.0.1:3000 in the test runner
 *   process. That conflicts with parallel Jest workers, with the
 *   spawn-based integration tests, and with anything else on the
 *   developer's machine using port 3000. Reconstructing the handler
 *   here lets in-process unit tests run on ephemeral ports while
 *   exercising semantically-identical code.
 *
 * Handler body — BYTE-EQUIVALENT to server.js:6-10:
 *   res.statusCode = 200;
 *   res.setHeader('Content-Type', 'text/plain');
 *   res.end('Hello, World!\n');
 *
 * @returns {import('http').Server} A non-listening `http.Server`
 *   instance ready to be passed to Supertest.
 */
function createEquivalentHandler() {
  return http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Hello, World!\n');
  });
}

// ---------------------------------------------------------------------------
// Module Exports (CommonJS, shorthand property syntax)
// ---------------------------------------------------------------------------

module.exports = {
  spawnServer,
  waitForListening,
  killAndWait,
  createEquivalentHandler,
  HTTP_METHODS,
  URL_PATHS,
  EXPECTED_BODY,
  EXPECTED_CONTENT_TYPE,
  EXPECTED_STARTUP_LOG,
};
