/**
 * tests/unit/server.coverage.test.js
 *
 * Istanbul coverage instrumentation tests for server.js.
 *
 * Purpose:
 *   The other unit tests (server.response, server.statusCode,
 *   server.headers, server.edgeCases) all use createEquivalentHandler()
 *   from tests/helpers/serverHelper.js — a byte-equivalent reconstruction
 *   of server.js's inline request handler. They never `require()` the
 *   real server.js, so Istanbul never instruments the subject file and
 *   reports 0% statement / function / line coverage on it. The
 *   integration tests (server.lifecycle, server.errors) execute the real
 *   server.js but in a SEPARATE Node.js process via
 *   child_process.spawn — and Istanbul's instrumentation runs only in
 *   the parent Jest worker, so the spawned-child execution is invisible
 *   to coverage collection.
 *
 *   This file fills that coverage gap by importing server.js DIRECTLY
 *   into the Jest worker's module registry (so Istanbul instruments
 *   it), while using `jest.spyOn(http, 'createServer')` to intercept
 *   the inline request handler before it is passed to a real
 *   http.Server, and using a mock `listen` to short-circuit the
 *   actual port-3000 binding. The captured handler and the captured
 *   listen callback are then manually invoked to exercise every
 *   executable statement in server.js — including the request
 *   handler body (server.js:7-9) and the listen callback body
 *   (server.js:13).
 *
 * Coverage gained for server.js (per AAP Section 0.7.1 targets):
 *   - Lines 1, 3, 4 (require, hostname, port constants): executed at
 *     module load time on the first `require(SERVER_JS_PATH)` inside
 *     `jest.isolateModules`.
 *   - Line 6 (http.createServer call): executed at module load time;
 *     the spy intercepts the call and captures the handler argument.
 *   - Lines 7-9 (handler body — statusCode, setHeader, end): executed
 *     when the test manually invokes the captured handler with mock
 *     req/res objects.
 *   - Line 12 (server.listen call): executed at module load time; the
 *     mock listen captures (port, hostname, callback) and synchronously
 *     invokes the callback to drive line 13.
 *   - Line 13 (console.log inside listen callback): executed when the
 *     mock listen invokes the captured callback synchronously.
 *
 *   Function coverage:
 *   - Function 1 — request handler arrow function (server.js:6-10):
 *     covered by Test 3 below (manually invoked with mock req/res).
 *   - Function 2 — listen callback arrow function (server.js:12-14):
 *     covered by Test 4 below (the mock listen invokes the callback
 *     synchronously inside the require call).
 *
 * Architectural Constraints (per AAP Section 0.10.1):
 *   - server.js is NOT modified — it remains byte-identical to the
 *     original. This file works around the un-exported, immediately-
 *     listening structure by mocking `http.createServer` and
 *     `server.listen` at the boundary, never modifying server.js.
 *   - CommonJS only (`require()` to match server.js style).
 *   - 2-space indentation, single-quote string literals, trailing
 *     semicolons matching server.js.
 *   - No `'use strict'` directive (server.js does not use one).
 *   - No port-3000 binding — the mock listen is a no-op for binding.
 *     This file is parallel-safe with the integration tests that DO
 *     bind port 3000 (lifecycle, errors).
 *
 * Critical insight on http.createServer spying:
 *   `http.createServer` is a function on the Node.js built-in http
 *   module. Native modules in Node.js return a single shared object
 *   reference regardless of how many times they are required, so
 *   mutating `http.createServer` via `jest.spyOn(http, 'createServer')`
 *   is visible to ANY code that subsequently does `require('http')`
 *   and calls `.createServer(...)` — including the require()'d
 *   server.js. The spy MUST be set up BEFORE server.js is required
 *   for the first time in this test process. The spy persists into
 *   the `jest.isolateModules` sandbox because native modules are not
 *   re-evaluated.
 *
 * Critical insight on jest.isolateModules vs require.cache:
 *   Jest replaces Node.js's native module loading mechanism with its
 *   own module registry. Deleting from `require.cache` does NOT clear
 *   Jest's registry, so a second `require(SERVER_JS_PATH)` after the
 *   first would return the cached module without re-executing the
 *   file. To force fresh execution per test (so spies are re-applied
 *   and `capturedHandler` / `capturedListenCallback` are re-populated),
 *   each test wraps its require in `jest.isolateModules`, which
 *   creates a fresh sandbox registry that is discarded when the
 *   callback returns.
 *
 * Critical insight on 100% function coverage:
 *   server.js declares two functions:
 *     - The arrow function passed to http.createServer (lines 6-10)
 *     - The arrow function passed to server.listen (lines 12-14)
 *   Both are covered: Test 3 invokes the request handler manually,
 *   and the mock listen synchronously invokes the listen callback
 *   during require() (Test 2 verifies the callback was captured;
 *   Test 4 verifies it was invoked and emitted the correct log).
 *
 * @see AAP Section 0.5.1 — File-by-File Test Plan (this file is added
 *      to the existing tests/unit/ directory to fill the coverage gap
 *      identified by the QA Final Checkpoint 3 report)
 * @see AAP Section 0.7.1 — Coverage Metrics
 *      (≥95% statements, ≥90% branches, 100% functions, ≥95% lines)
 * @see AAP Section 0.10.1 — Minimal Change Principle (server.js MUST
 *      remain byte-identical; testability is achieved via this file's
 *      mocking strategy, not via source-code modification)
 * @see AAP Section 0.10.3 criterion 6 — Coverage threshold met
 */

const http = require('http');
const path = require('path');

/**
 * Absolute filesystem path to the subject server.js at the repository
 * root. Resolved via `path.resolve` from this file's directory:
 *   tests/unit/server.coverage.test.js → '..' (tests/) → '..'
 *   (repository root) → 'server.js'.
 *
 * Using an absolute path ensures `require(SERVER_JS_PATH)` resolves
 * unambiguously regardless of where Jest was invoked from.
 *
 * @type {string}
 */
const SERVER_JS_PATH = path.resolve(__dirname, '..', '..', 'server.js');

// ---------------------------------------------------------------------------
// Describe Block — server.js Istanbul coverage instrumentation
// ---------------------------------------------------------------------------
//
// All tests in this block share the same beforeEach setup:
//   1. Reset capture state (capturedHandler, capturedListenArgs,
//      capturedListenCallback) to null so each test starts clean.
//   2. Construct a fresh mockServer object with a Jest mock listen()
//      that captures arguments and synchronously invokes the callback.
//   3. Spy on http.createServer to intercept the call and capture the
//      handler argument before the real server.js handler would
//      otherwise be passed to a real http.Server.
//   4. Spy on console.log to suppress the startup-log output and
//      capture the invocation for assertion in Test 4.
//
// Each test then issues `jest.isolateModules(() =>
// require(SERVER_JS_PATH))` to drive Istanbul instrumentation in a
// fresh module sandbox, followed by focused assertions on a specific
// aspect of the captured behavior. The afterEach block restores all
// spies to prevent cross-test pollution.
// ---------------------------------------------------------------------------

describe('server.js Istanbul coverage instrumentation', () => {
  let createServerSpy;
  let consoleLogSpy;
  let capturedHandler;
  let capturedListenArgs;
  let capturedListenCallback;
  let mockServer;

  beforeEach(() => {
    // Reset capture state. Each test runs an independent require()
    // and asserts on the freshly-populated capture variables.
    capturedHandler = null;
    capturedListenArgs = null;
    capturedListenCallback = null;

    // Mock http.Server replacement returned by the createServer spy.
    // Provides a Jest mock function for `listen` that:
    //   - Captures (port, hostname) into capturedListenArgs for
    //     server.listen call-argument assertions.
    //   - Captures the listen callback into capturedListenCallback.
    //   - Synchronously invokes the callback (if provided) to exercise
    //     server.js:13 (console.log startup message). Synchronous
    //     invocation is critical: without it, the listen callback
    //     would never run inside the `require()` invocation and
    //     server.js:13 would remain uncovered by Istanbul.
    //   - Returns `this` to preserve the chainable-API convention of
    //     the real http.Server (server.listen() returns the server).
    mockServer = {
      listen: jest.fn(function listenMock(port, hostname, callback) {
        capturedListenArgs = { port: port, hostname: hostname };
        capturedListenCallback = callback;
        if (typeof callback === 'function') {
          callback();
        }
        return this;
      }),
    };

    // Spy on http.createServer to capture the inline request handler
    // passed by server.js:6 BEFORE it would be wired into a real
    // http.Server. The mock returns mockServer instead — preventing
    // the port-3000 binding side-effect that would normally occur
    // when require()-ing server.js.
    //
    // Note: `jest.spyOn(http, 'createServer')` mutates the shared
    // `http` module object. Because Node.js native modules return a
    // single shared object reference, server.js's
    // `const http = require('http')` returns the SAME object (with
    // our spy in effect), even when wrapped in jest.isolateModules.
    createServerSpy = jest
      .spyOn(http, 'createServer')
      .mockImplementation((handler) => {
        capturedHandler = handler;
        return mockServer;
      });

    // Spy on console.log to silently capture the startup message
    // emitted by server.js:13 (`console.log(\`Server running at
    // http://${hostname}:${port}/\`)`). Using mockImplementation(()
    // => {}) suppresses console output during test runs, keeping the
    // test output clean while still recording the invocation for
    // assertion via toHaveBeenCalledWith.
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the original implementations of http.createServer and
    // console.log to prevent cross-test pollution. After mockRestore,
    // the spy is removed and the original function is reattached to
    // the http / console object.
    createServerSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 1 — http.createServer is invoked with a function handler on
  //          require (covers server.js lines 1, 3, 4, 6)
  // -------------------------------------------------------------------------
  //
  // Verifies the module-load-time invocation of http.createServer at
  // server.js:6. By the time `jest.isolateModules(() =>
  // require(SERVER_JS_PATH))` returns, server.js has executed lines 1
  // (http require), 3-4 (hostname / port constants), and 6
  // (http.createServer call). Our spy intercepted the call and
  // captured the handler argument.
  //
  // Two focused assertions:
  //   1. createServerSpy was called exactly once (one createServer
  //      invocation in server.js).
  //   2. The captured argument is a function (the inline arrow
  //      function from server.js:6-10). We assert via `typeof` rather
  //      than `instanceof Function` to accommodate both regular and
  //      arrow function definitions identically.
  // -------------------------------------------------------------------------

  it('invokes http.createServer once with a function handler on require', () => {
    jest.isolateModules(() => {
      require(SERVER_JS_PATH);
    });

    expect(createServerSpy).toHaveBeenCalledTimes(1);
    expect(typeof capturedHandler).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Test 2 — server.listen is invoked with port 3000, hostname
  //          '127.0.0.1', and a callback (covers server.js line 12)
  // -------------------------------------------------------------------------
  //
  // Verifies the module-load-time invocation of server.listen at
  // server.js:12. Asserts on the AAP-specified hostname constant
  // ('127.0.0.1' from server.js:3) and port constant (3000 from
  // server.js:4) being passed correctly to listen, and asserts that
  // a callback function was passed (the inline arrow function from
  // server.js:12-14 that contains the console.log startup message).
  //
  // Three focused assertions:
  //   1. mockServer.listen was called exactly once.
  //   2. The captured (port, hostname) match the AAP-specified
  //      constants.
  //   3. The captured listen callback is a function (the inline
  //      arrow function from server.js:12-14).
  // -------------------------------------------------------------------------

  it('invokes server.listen with port 3000, hostname 127.0.0.1, and a callback on require', () => {
    jest.isolateModules(() => {
      require(SERVER_JS_PATH);
    });

    expect(mockServer.listen).toHaveBeenCalledTimes(1);
    expect(capturedListenArgs).toEqual({ port: 3000, hostname: '127.0.0.1' });
    expect(typeof capturedListenCallback).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Test 3 — Request handler sets statusCode 200, Content-Type
  //          text/plain, and ends with 'Hello, World!\n'
  //          (covers server.js lines 7-9 and Function 1)
  // -------------------------------------------------------------------------
  //
  // Manually invokes the captured request handler with mock req/res
  // objects to exercise the three statements inside the inline arrow
  // function at server.js:6-10. Without this manual invocation, the
  // handler body (lines 7-9) would never execute during testing and
  // Istanbul would report 0% function coverage for Function 1 and
  // 0% line coverage for lines 7-9.
  //
  // Three focused assertions on the response mutations performed by
  // the handler:
  //   1. res.statusCode is set to 200 (server.js:7).
  //   2. res.setHeader is called with ('Content-Type', 'text/plain')
  //      (server.js:8).
  //   3. res.end is called with the exact 'Hello, World!\n' body
  //      (server.js:9).
  //
  // The mock req object is empty `{}` because the server.js handler
  // never reads any request property — it produces a uniform
  // response regardless of the request shape.
  // -------------------------------------------------------------------------

  it('request handler sets statusCode 200, Content-Type text/plain, and ends with Hello World body', () => {
    jest.isolateModules(() => {
      require(SERVER_JS_PATH);
    });

    const mockReq = {};
    const mockRes = {
      statusCode: 0,
      setHeader: jest.fn(),
      end: jest.fn(),
    };

    // Invoke the captured handler — exercises server.js lines 7-9.
    capturedHandler(mockReq, mockRes);

    expect(mockRes.statusCode).toBe(200);
    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
    expect(mockRes.end).toHaveBeenCalledWith('Hello, World!\n');
  });

  // -------------------------------------------------------------------------
  // Test 4 — Listen callback emits the expected startup log via
  //          console.log (covers server.js line 13 and Function 2)
  // -------------------------------------------------------------------------
  //
  // The mock server.listen synchronously invokes its callback
  // argument inside the `jest.isolateModules(() =>
  // require(SERVER_JS_PATH))` call (see beforeEach setup). The
  // callback is the inline arrow function from server.js:12-14 whose
  // body is `console.log(\`Server running at
  // http://${hostname}:${port}/\`)`. With our console.log spy, the
  // invocation is captured and we assert on:
  //
  //   1. console.log was called exactly once during require (one
  //      startup log emission per server start).
  //   2. The argument matches the resolved template literal exactly:
  //      'Server running at http://127.0.0.1:3000/' — derived from
  //      hostname='127.0.0.1' (server.js:3) and port=3000
  //      (server.js:4).
  //
  // This test is what gives Function 2 (the listen callback) its
  // coverage hit, taking function coverage from 50% to 100%.
  // -------------------------------------------------------------------------

  it('listen callback emits the expected startup log via console.log', () => {
    jest.isolateModules(() => {
      require(SERVER_JS_PATH);
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith('Server running at http://127.0.0.1:3000/');
  });
});
