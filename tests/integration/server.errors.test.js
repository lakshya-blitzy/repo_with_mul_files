/**
 * tests/integration/server.errors.test.js
 *
 * Tier 2 out-of-process integration tests covering ERROR scenarios for
 * server.js (per AAP Section 0.4.1). These tests spawn server.js as a
 * separate Node.js child process via `child_process.spawn` (delegated to
 * the shared `spawnServer` helper) and verify two failure modes:
 *
 *   1. Port-conflict (EADDRINUSE) — Two sequential `node server.js`
 *      invocations against the same loopback port (3000). Because
 *      server.js installs NO `server.on('error', ...)` listener, the
 *      second instance's underlying net.Server emits an unhandled
 *      'error' event with `code: 'EADDRINUSE'`. Node.js's default
 *      uncaught-exception handler then prints the error to stderr and
 *      exits with a non-zero exit code (typically 1). The test asserts
 *      both observable side effects — non-zero exit code and the literal
 *      string 'EADDRINUSE' present in captured stderr.
 *
 *   2. Malformed HTTP request — A raw TCP socket (via Node's built-in
 *      `net` module, bypassing Supertest because Supertest's HTTP
 *      client cannot emit syntactically invalid HTTP) writes the byte
 *      sequence 'GARBAGE NOT VALID HTTP\r\n\r\n' to 127.0.0.1:3000.
 *      Because server.js installs NO `server.on('clientError', ...)`
 *      listener, Node's HTTP module triggers its DEFAULT clientError
 *      behavior: send a `400 Bad Request` response and destroy the
 *      socket. Critically, the SERVER PROCESS itself does NOT crash.
 *      The test verifies (a) the child's `exitCode` and `signalCode`
 *      remain `null` (process still alive) and (b) a fresh TCP
 *      connection to the listening socket succeeds (server still
 *      accepting connections).
 *
 * A third scenario (EACCES on privileged port) is documented but
 * `it.skip`-ped because server.js hard-codes port 3000 (non-privileged)
 * and modifying server.js to test the privileged-port path is forbidden
 * by AAP Section 0.10.1 Minimal Change Principle.
 *
 * Architectural Constraints (per AAP Section 0.10.1):
 *   - CommonJS only (`require()` to match server.js style)
 *   - 2-space indentation, single-quote string literals, trailing semicolons
 *   - No `'use strict'` directive (server.js does not use one)
 *   - No `require('../../server.js')` — would synchronously bind port 3000
 *   - Tests bind real port 3000 → invoke with `--runInBand` for isolation
 *   - Per-test cleanup via `afterEach` SIGKILL of any leftover children
 *   - Generous timeouts (5-30 seconds) to absorb slow-CI variance
 *
 * Critical Synchronization Note — 'close' vs 'exit' event:
 *   The EADDRINUSE test waits on the second child's `'close'` event,
 *   NOT `'exit'`. Per Node.js docs: 'exit' fires when the process ends
 *   but stdio streams may still be flushing; 'close' fires AFTER all
 *   stdio streams are closed. Asserting on `stderr.content` requires
 *   the stderr buffer to be fully flushed, which is only guaranteed
 *   after 'close'. Using 'exit' here would intermittently flake on slow
 *   systems where the EADDRINUSE message is emitted between exit and
 *   stream-close events.
 *
 * Why raw TCP for the malformed-HTTP test:
 *   Supertest (and any standards-compliant HTTP client) ALWAYS produces
 *   syntactically valid HTTP request lines. To force the server's HTTP
 *   parser into a failure path, the test must write deliberately
 *   malformed bytes — only achievable via a raw TCP socket (Node's
 *   `net.createConnection` / `net.connect`). The bytes
 *   'GARBAGE NOT VALID HTTP\r\n\r\n' do not match the
 *   `METHOD SP PATH SP HTTP-VERSION CRLF` format mandated by RFC 7230
 *   and trigger a parser error, which the HTTP module surfaces as a
 *   'clientError' event.
 *
 * Why a TCP-only sanity check after the malformed request:
 *   The strongest evidence that the malformed request did not
 *   destabilize the server is to open a FRESH connection and observe
 *   that the listening socket still accepts it. Using a TCP-only probe
 *   (rather than a full HTTP request) keeps this test focused on
 *   "server is still listening" without coupling to HTTP-level
 *   behavior already covered by tests/unit/* and the lifecycle tests.
 *
 * @see AAP Section 0.1.3 — Technical Interpretation (server error handling)
 * @see AAP Section 0.4.1 — Test Strategy Selection (Tier 2 out-of-process)
 * @see AAP Section 0.4.2 — Test Case Blueprint (EADDRINUSE, clientError)
 * @see AAP Section 0.5.1 — File-by-File Test Plan, Row 6
 * @see AAP Section 0.5.2 — New Test Files Detail (3-4 tests, 1 skipped)
 * @see AAP Section 0.10.2 — Implicit Quality Directives (behavioral fidelity)
 */

const net = require('net');
const {
  spawnServer,
  waitForListening,
  killAndWait,
} = require('../helpers/serverHelper');

// ---------------------------------------------------------------------------
// Describe Block 1 — EADDRINUSE Port Conflict (1 active test)
// ---------------------------------------------------------------------------

describe('server.js error scenarios — port conflicts (EADDRINUSE)', () => {
  // Tracks every ChildProcess spawned during the current test. The
  // afterEach hook iterates this list and SIGKILLs any leftover
  // children so port 3000 is fully released before the next test runs.
  // Reset to an empty array at the start of each test to avoid carrying
  // exited-process references across tests.
  let spawnedChildren;

  beforeEach(() => {
    spawnedChildren = [];
  });

  afterEach(async () => {
    // Iterate snapshot — any already-exited children are skipped.
    for (const child of spawnedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          // SIGKILL guarantees termination even if the child has
          // installed signal handlers in some hypothetical future
          // version of server.js. The 5s timeout is generous; SIGKILL
          // delivery is typically immediate on POSIX systems.
          await killAndWait(child, 'SIGKILL', 5000);
        } catch (err) {
          // Cleanup errors (e.g., child already exited between the
          // null-check and the kill call) are non-fatal. The test
          // assertions have already passed at this point.
        }
      }
    }
    spawnedChildren = [];
    // Brief settle window: TCP socket close on Linux is asynchronous
    // and the kernel may hold the port in TIME_WAIT briefly. 200ms is
    // empirically sufficient on modern Linux kernels with SO_REUSEADDR
    // (which Node's net.Server enables by default for the listening
    // socket). Without this delay, a back-to-back test could see a
    // transient EADDRINUSE on the next spawn.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('a second instance fails with non-zero exit and EADDRINUSE on stderr when port 3000 is already bound', async () => {
    // Step 1: Spawn the FIRST server instance and wait for it to be
    // fully listening on 127.0.0.1:3000. The waitForListening helper
    // resolves only after the startup-log substring appears on stdout,
    // which server.js emits inside the listen() callback — so when
    // this resolves, the OS-level bind() has completed.
    const first = spawnServer();
    spawnedChildren.push(first.child);
    await waitForListening(first.stdout, 5000);

    // Step 2: Spawn the SECOND server instance. This child will
    // attempt to bind 127.0.0.1:3000, fail with EADDRINUSE, and
    // (because server.js has no 'error' handler) crash via the
    // default uncaught-exception path.
    const second = spawnServer();
    spawnedChildren.push(second.child);

    // Step 3: Wait for the second child's 'close' event. We use
    // 'close' (not 'exit') because 'close' fires AFTER stdout/stderr
    // are flushed — required for the stderr.content assertion below.
    // The 10s timeout is a generous buffer; in practice EADDRINUSE
    // detection happens within ~100-500ms of spawn.
    const closeResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Second instance did not exit within 10s')),
        10000
      );
      second.child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    // Assertion 1: Non-zero exit code.
    // Node.js's default uncaught-exception handler exits with code 1
    // when an unhandled 'error' event escapes. We assert .not.toBe(0)
    // (rather than .toBe(1)) to be robust against future Node.js
    // versions that might use a different non-zero code.
    expect(closeResult.code).not.toBe(0);

    // Assertion 2: 'EADDRINUSE' substring appears in captured stderr.
    // Node.js's default error printer emits a multi-line stack trace
    // containing the literal string "EADDRINUSE" (e.g.,
    // "Error: listen EADDRINUSE: address already in use 127.0.0.1:3000").
    // We use toContain (substring match) rather than toMatch (regex)
    // to avoid coupling to the surrounding error-message format,
    // which has changed between Node.js major versions.
    expect(second.stderr.content).toContain('EADDRINUSE');
  }, 30000);
});

// ---------------------------------------------------------------------------
// Describe Block 2 — Malformed HTTP Requests (1 active test + 1 skipped)
// ---------------------------------------------------------------------------

describe('server.js error scenarios — malformed HTTP requests (no clientError handler)', () => {
  // See describe-block-1 comment for cleanup semantics. Each describe
  // block declares its own spawnedChildren variable rather than sharing
  // a module-level variable to keep state strictly scoped.
  let spawnedChildren;

  beforeEach(() => {
    spawnedChildren = [];
  });

  afterEach(async () => {
    for (const child of spawnedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          await killAndWait(child, 'SIGKILL', 5000);
        } catch (err) {
          // Ignore cleanup errors — assertions have already passed.
        }
      }
    }
    spawnedChildren = [];
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('does not crash when receiving a malformed HTTP request via raw TCP socket', async () => {
    // Step 1: Spawn server.js and wait for it to be listening on
    // 127.0.0.1:3000. We only need the child handle and stdout
    // accumulator (stderr is unused for this test — the malformed
    // request should not produce any stderr output from the server).
    const { child, stdout } = spawnServer();
    spawnedChildren.push(child);
    await waitForListening(stdout, 5000);

    // Step 2: Open a raw TCP connection and write malformed bytes.
    // The promise resolves under any of three conditions:
    //   (a) the socket emits 'close' (server destroyed the connection
    //       in response to the parser error — expected default path),
    //   (b) the socket emits 'error' (e.g., ECONNRESET if the server
    //       resets without sending a response), or
    //   (c) a 1s safety-net timeout (in case the server holds the
    //       connection open without sending a response).
    // In all three cases, what matters is that the SERVER (the parent
    // child process) is still alive after this exchange — verified
    // by the assertions that follow.
    await new Promise((resolve) => {
      const socket = net.createConnection({ port: 3000, host: '127.0.0.1' });
      // The `resolved` flag is a single-shot guard: 'close', 'error',
      // and the safety-net timer can all fire in any order, but the
      // promise must only resolve once. Without this guard, repeated
      // resolution is silently ignored by the Promise spec but the
      // socket.destroy() call inside safeResolve could throw on an
      // already-destroyed socket.
      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          try {
            socket.destroy();
          } catch (err) {
            // socket.destroy on an already-destroyed socket is a
            // no-op in modern Node.js, but we wrap defensively in
            // case of platform-specific edge cases.
          }
          resolve();
        }
      };

      // Send the deliberately malformed bytes as soon as the TCP
      // handshake completes. The string 'GARBAGE NOT VALID HTTP'
      // does NOT conform to the RFC 7230 request-line format
      // (METHOD SP PATH SP HTTP-VERSION). Node's HTTP parser
      // rejects it and emits a 'clientError' event on the server.
      socket.once('connect', () => {
        socket.write('GARBAGE NOT VALID HTTP\r\n\r\n');
      });

      // Either 'close' or 'error' indicates the server has finished
      // handling the malformed exchange. Both paths converge on the
      // same safeResolve to make the test resilient to platform and
      // Node-version-specific behaviors (some Node versions send
      // 400 + close; others may RST without a response).
      socket.once('close', safeResolve);
      socket.once('error', safeResolve);

      // Safety net: if the server somehow holds the connection open
      // without responding (which would indicate a server bug, but
      // is not the failure mode we are testing for here), proceed
      // after 1 second so the test does not hang indefinitely.
      setTimeout(safeResolve, 1000);
    });

    // Step 3: Wait briefly to allow the server time to crash if it
    // would. server.js has no try/catch around the request listener
    // and no process.on('uncaughtException') handler, so any
    // unhandled exception in the request path WOULD bring the
    // process down. After 200ms with no exit, we can confidently
    // assert the process is still alive.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assertion 1: Server process is still running.
    // ChildProcess.exitCode is null while the process is alive and
    // becomes a number on normal exit. ChildProcess.signalCode is
    // null while alive and becomes a signal name (e.g., 'SIGTERM')
    // on signal-induced exit. Both being null is the unambiguous
    // signature of a still-running child.
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    // Step 4 / Assertion 2: Sanity check via fresh TCP connection.
    // The strongest available proof that the listening socket
    // remains operational is to open a new connection and verify
    // it succeeds. We use a TCP-only probe (no HTTP request) to
    // keep the assertion focused on "server is listening" rather
    // than "server still serves valid HTTP" (the latter is covered
    // by the lifecycle test and unit tests).
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ port: 3000, host: '127.0.0.1' });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('Sanity check connection timeout'));
      }, 2000);
      sock.once('connect', () => {
        clearTimeout(timer);
        // Cleanly close our half of the connection without
        // sending data. The server will then close its half on
        // the next event-loop tick. Using `.end()` (FIN) rather
        // than `.destroy()` (RST) keeps the test fully
        // protocol-compliant.
        sock.end();
        resolve();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }, 30000);

  // EACCES privileged-port test — INTENTIONALLY SKIPPED.
  //
  // Per AAP Section 0.4.2:
  //   "EACCES (privileged port — only feasible if test environment
  //    grants/denies CAP_NET_BIND_SERVICE; documented but NOT executed
  //    in CI)"
  //
  // Per AAP Section 0.5.2:
  //   "skipped EACCES test (privileged port; documented but conditional
  //    on capability availability)"
  //
  // Why we cannot execute this test:
  //   1. server.js hard-codes port = 3000 (non-privileged). To trigger
  //      EACCES, the listen() call would need to target a port < 1024
  //      from a non-root process. Modifying server.js to read the port
  //      from an env var (or hard-coding to <1024) is forbidden by AAP
  //      Section 0.10.1 Minimal Change Principle.
  //   2. Even if we could override the port, the test environment may
  //      grant CAP_NET_BIND_SERVICE (e.g., root containers, some CI
  //      runners), causing the bind to succeed and the EACCES
  //      assertion to fail unexpectedly.
  //
  // Using `it.skip` (rather than removing the test outright) preserves
  // the documentation in the test report — Jest output will explicitly
  // show this scenario as skipped, signaling to readers that the
  // failure mode was considered and consciously deferred.
  it.skip('emits EACCES when binding to privileged port (environment-dependent)', async () => {
    // Implementation deferred per AAP Sections 0.4.2 and 0.5.2.
    // server.js hard-codes port=3000 (non-privileged) and modifying
    // server.js is forbidden per AAP Section 0.10.1 Minimal Change
    // Principle. See the leading comment block for full rationale.
  });
});
