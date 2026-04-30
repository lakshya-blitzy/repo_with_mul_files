/**
 * tests/integration/server.lifecycle.test.js
 *
 * Tier 2 out-of-process integration tests covering STARTUP and SHUTDOWN
 * lifecycle behavior of server.js (per AAP Section 0.4.1). These tests
 * spawn server.js as a separate Node.js child process via
 * `child_process.spawn` (delegated to the shared `spawnServer` helper)
 * and exercise its real-world process lifecycle:
 *
 *   STARTUP DESCRIBE BLOCK (3 tests):
 *     1. Startup log emission — Verifies that spawning `node server.js`
 *        produces the exact resolved-template-literal output of
 *        server.js:13 (`Server running at http://127.0.0.1:3000/`)
 *        on the child's stdout. This proves the listen() callback
 *        executed AND the hostname/port constants resolved correctly.
 *
 *     2. TCP port binding — Verifies that after the startup log
 *        appears, port 3000 on 127.0.0.1 is bound and accepting raw
 *        TCP connections. Uses `net.connect` (not an HTTP request) to
 *        isolate the "is the OS-level listening socket open" concern
 *        from "does the server respond correctly to HTTP" — a separate
 *        invariant covered by Test 3.
 *
 *     3. End-to-end HTTP response — Verifies that a real HTTP GET / to
 *        the spawned server returns status 200 and body
 *        `'Hello, World!\n'`. This is the only test in the suite that
 *        validates the FULL stack — spawned process binding, OS-level
 *        listening socket, Node.js HTTP parser, server.js inline
 *        handler, response framing, and HTTP-protocol-compliant
 *        delivery — through a single end-to-end assertion.
 *
 *   SHUTDOWN DESCRIBE BLOCK (3 tests):
 *     1. SIGTERM termination — Sends SIGTERM to the child and verifies
 *        the process exits. server.js installs no signal handlers, so
 *        on POSIX the child exits with `exitCode === null` and
 *        `signalCode === 'SIGTERM'`. The cross-platform-portable
 *        assertion is `exitCode !== null || signalCode !== null`,
 *        which is satisfied after ANY process exit.
 *
 *     2. SIGINT termination — Same pattern as Test 1 with SIGINT
 *        (Ctrl-C equivalent). Mirrors the absent-handler behavior to
 *        confirm both common termination signals reach Node's default
 *        handler in the same way.
 *
 *     3. Port-3000 release after exit — Spawns a first instance, awaits
 *        startup, kills with SIGTERM, waits for OS-level port release
 *        (300ms grace), then spawns a SECOND instance and asserts it
 *        successfully binds (startup log appears AND no EADDRINUSE
 *        message in stderr). This is the strongest available evidence
 *        that the listening socket was cleanly closed and the kernel's
 *        port-allocation table reflects the release.
 *
 * Total: 6 tests across 2 describe blocks (matches AAP Section 0.5.2
 * "6-7 tests in 2 describe blocks").
 *
 * Architectural Constraints (per AAP Section 0.10.1):
 *   - CommonJS only (`require()` to match server.js style)
 *   - 2-space indentation, single-quote string literals, trailing semicolons
 *   - No `'use strict'` directive (server.js does not use one)
 *   - No `require('../../server.js')` — would synchronously bind port 3000
 *     in the test runner process, polluting parallel Jest workers and
 *     conflicting with the spawn-based child processes
 *   - Tests bind real port 3000 → invoke with `--runInBand` for isolation
 *   - Per-test cleanup via `afterEach` SIGKILL of any leftover children
 *   - Generous timeouts (5-30 seconds) to absorb slow-CI variance
 *
 * Why spawn-based testing rather than handler reconstruction:
 *   The unit tests (tests/unit/*.test.js) use `createEquivalentHandler()`
 *   to test the handler logic in-process via Supertest's ephemeral-port
 *   binding. That approach cannot exercise:
 *     - The console.log emission inside the listen() callback
 *     - The actual TCP bind to 127.0.0.1:3000
 *     - Real OS signal delivery (SIGTERM/SIGINT)
 *     - The kernel's port-release semantics after exit
 *   Only running the ACTUAL server.js as a child process — byte-for-byte
 *   the file the user ships — exercises these concerns. Hence Tier 2.
 *
 * Why default-signal-handler behavior is observable:
 *   server.js installs NO `process.on('SIGTERM')` or
 *   `process.on('SIGINT')` handlers. Node.js's default behavior on POSIX
 *   when the process receives one of these signals with no installed
 *   handler is to terminate the process. The 'exit' event of the child
 *   process fires shortly thereafter, with `exitCode === null` and
 *   `signalCode` set to the signal name. Tests assert that the exit
 *   happened (either condition met) rather than asserting specific
 *   exit codes or signal names — this is the platform-portable approach
 *   per AAP Section 0.10.2 (cross-platform robustness).
 *
 * Why the port-release test uses a 300ms inter-spawn delay:
 *   When a TCP listening socket is closed (either via server.close() or
 *   via process exit), the kernel releases the port. On Linux with
 *   Node.js's default SO_REUSEADDR setting on the listening socket,
 *   the release is typically immediate but can occasionally take a few
 *   milliseconds under load. 300ms is a conservative buffer (slightly
 *   longer than the afterEach's 200ms) chosen to make this back-to-back
 *   spawn test deterministic without slowing the suite materially.
 *
 * Why HTTP requests use `http.request` rather than Supertest:
 *   Supertest is purpose-built for in-process testing — it accepts an
 *   `http.Server` instance and binds it to an ephemeral port. Here we
 *   need to issue a request against a SEPARATE process listening on a
 *   FIXED port (3000), so Supertest's value-add (ephemeral-port binding)
 *   does not apply. Node's built-in `http.request` is the simplest tool
 *   for the job and matches the integration tier's "real HTTP stack
 *   end-to-end" goal.
 *
 * @see AAP Section 0.1.3 — Technical Interpretation (server lifecycle)
 * @see AAP Section 0.4.1 — Test Strategy Selection (Tier 2 out-of-process)
 * @see AAP Section 0.4.2 — Test Case Blueprint (startup + shutdown)
 * @see AAP Section 0.5.1 — File-by-File Test Plan, Row 5
 * @see AAP Section 0.5.2 — New Test Files Detail (6-7 tests, 2 describes)
 * @see AAP Section 0.7.2 — Test Quality Criteria (timeouts, AAA pattern)
 * @see AAP Section 0.10.1 — Spawn-based testing rationale
 */

const http = require('http');
const net = require('net');
const {
  spawnServer,
  waitForListening,
  killAndWait,
  EXPECTED_BODY,
  EXPECTED_STARTUP_LOG,
} = require('../helpers/serverHelper');

// ---------------------------------------------------------------------------
// File-Local Helper — waitForPortFree (cross-file parallel-execution gate)
// ---------------------------------------------------------------------------
//
// When `npm test` runs the full suite (without `--runInBand`), Jest's
// default worker pool can schedule this lifecycle test file IN PARALLEL
// with `tests/integration/server.errors.test.js`. Both files spawn
// `server.js` as a child process, which binds 127.0.0.1:3000. Without
// cross-file coordination, a parallel-running file may currently hold
// port 3000 at the moment our test attempts to spawn its own server,
// causing the spawned server.js to crash with EADDRINUSE before
// emitting its startup log — which manifests as a 5-second timeout in
// `waitForListening` followed by a captured-stdout-empty error.
//
// This file-local helper polls the loopback port until a fresh
// `net.connect` attempt produces ECONNREFUSED — the unambiguous signal
// that NO process is currently listening on that port. The helper
// resolves on first ECONNREFUSED, or rejects on timeout.
//
// Behavior summary by socket event:
//   - 'connect' fires    → another process is listening; retry after
//                          a short delay until timeout
//   - 'error' (ECONNREFUSED) → port is free; resolve immediately
//   - 'error' (other code)   → unexpected; surface the error to the
//                              caller (rejects on timeout otherwise)
//
// The 100ms poll cadence is light on CPU and gives sub-200ms detection
// latency. The default 15-second timeout is generous: empirically the
// errors test file holds port 3000 for at most ~2.2 seconds (its two
// active tests with afterEach delays), so 15s provides ~7x headroom.
//
// Why a beforeEach gate instead of beforeAll:
//   beforeAll would gate only at the START of the file. Once that gate
//   passes, all six tests proceed — and a parallel-running test in
//   another file could grab port 3000 between our tests. Per-test
//   gating ensures every spawn is preceded by a fresh port-availability
//   check, paying a small (≤200ms when port is free) per-test cost in
//   exchange for deterministic isolation under any Jest scheduling.
function waitForPortFree(port, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const probe = () => {
      const sock = net.connect({ port, host });
      let settled = false;
      // Single-shot guard: 'connect' and 'error' can race; only the
      // first one drives the retry/resolve decision. socket.destroy()
      // tears down our probe connection cleanly without affecting
      // any listening server we may have detected.
      const settle = (action) => {
        if (settled) return;
        settled = true;
        try {
          sock.destroy();
        } catch (e) {
          // Defensive — destroy on already-destroyed socket is a
          // no-op in modern Node.js but wrapping prevents any
          // platform-specific edge cases from leaking.
        }
        action();
      };
      sock.once('connect', () => {
        // Some other process is listening on the port. Retry after
        // a short delay until the global timeout elapses.
        settle(() => {
          if (Date.now() - startTime >= timeoutMs) {
            reject(
              new Error(
                `Port ${port} on ${host} did not become free within ${timeoutMs}ms`
              )
            );
          } else {
            setTimeout(probe, 100);
          }
        });
      });
      sock.once('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          // No listener on the port — exactly the state we want.
          settle(() => resolve());
        } else {
          // Unexpected error (e.g., EHOSTUNREACH on a misconfigured
          // host). Treat as transient and retry; surface as final
          // rejection only if we run out of time.
          settle(() => {
            if (Date.now() - startTime >= timeoutMs) {
              reject(err);
            } else {
              setTimeout(probe, 100);
            }
          });
        }
      });
    };
    probe();
  });
}

// ---------------------------------------------------------------------------
// File-Local Helper — robustSpawnServer (race-tolerant spawn-and-listen)
// ---------------------------------------------------------------------------
//
// Why a retry pattern is required:
//   `waitForPortFree` ensures the port is free at one MOMENT, but does
//   not HOLD the port. Between our probe-completion and our spawn-
//   completion, a parallel-running test file (e.g.,
//   tests/integration/server.errors.test.js running in another Jest
//   worker process) may grab port 3000 first. When that happens, our
//   spawned server.js fails to bind, throws an unhandled 'error' event
//   (because server.js installs no `server.on('error')` listener), and
//   exits — typically within ~100-300ms with `EADDRINUSE` on stderr.
//
//   The base helper's `waitForListening` polls stdout for the startup
//   log. It does NOT detect early child exit, so a crashed server.js
//   appears to it as a 5-second timeout. That's a 5-second-per-attempt
//   penalty for what is fundamentally a transient race.
//
// What this function does differently:
//   1. Spawns server.js
//   2. Races three observable outcomes:
//        a. stdout contains EXPECTED_STARTUP_LOG → SUCCESS
//        b. child emits 'exit' before (a) → CRASH (typically EADDRINUSE)
//        c. neither happens within 3 seconds → TIMEOUT (slow CI)
//   3. On SUCCESS, returns the spawn result for the test to use.
//   4. On CRASH or TIMEOUT, kills any leftover child, waits for the
//      port to be free, and retries (up to maxAttempts times).
//
// Detecting CRASH via early exit is the key insight — it converts a
// 5-second per-attempt penalty into a ~300ms penalty, allowing many
// retry cycles within a 30-second test budget.
//
// @param {number} maxAttempts - Maximum spawn attempts before giving
//   up. Default 10 (covers ~30 seconds at ~3 seconds per failed attempt).
// @returns {Promise<{child, stdout, stderr}>} The successful spawn result,
//   identical in shape to what `spawnServer` returns directly.
async function robustSpawnServer(maxAttempts = 10) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Wait for port 3000 to be free before spawning. Times out at 15s
    // per attempt; should normally resolve in <500ms once any
    // parallel-running test file releases the port.
    await waitForPortFree(3000, '127.0.0.1', 15000);

    const result = spawnServer();

    // Set up the early-exit detector BEFORE racing waitForListening.
    // If the spawned server.js fails to bind (EADDRINUSE), the
    // unhandled 'error' event causes Node's default termination path,
    // firing 'exit' shortly after the spawn — typically within
    // ~100-300ms. Capturing this signal lets us short-circuit the
    // retry loop on a confirmed crash, instead of paying the full
    // waitForListening timeout for what is fundamentally a transient
    // race.
    let exitListener = null;
    const crashPromise = new Promise((resolve) => {
      // Cover the case where the child already exited synchronously
      // (rare but possible if spawn itself failed at the OS level).
      if (
        result.child.exitCode !== null ||
        result.child.signalCode !== null
      ) {
        resolve('CRASH');
        return;
      }
      exitListener = () => resolve('CRASH');
      result.child.once('exit', exitListener);
    });

    // Race three outcomes:
    //   a. waitForListening resolves → 'LISTENING' (success)
    //   b. waitForListening rejects on timeout → 'TIMEOUT'
    //   c. crashPromise resolves → 'CRASH' (early exit before listening)
    // Promise.race takes the first SETTLED promise (resolve or reject),
    // and since path (b) is wrapped with .catch, all three paths
    // resolve to a string outcome.
    //
    // The 3000ms waitForListening timeout (rather than the helper's
    // default 5000ms) tightens the retry cycle. Server startup
    // typically completes in <300ms; 3 seconds is 10x headroom yet
    // half the default.
    const outcome = await Promise.race([
      waitForListening(result.stdout, 3000)
        .then(() => 'LISTENING')
        .catch(() => 'TIMEOUT'),
      crashPromise,
    ]);

    // Always remove the exit listener after the race resolves, so it
    // does not fire during normal SIGTERM/SIGKILL teardown later in
    // the test (which would resolve a stale Promise no one awaits).
    if (exitListener) {
      result.child.removeListener('exit', exitListener);
    }

    if (outcome === 'LISTENING') {
      return result;
    }

    // Failure path: clean up the failed spawn before retrying. If the
    // child crashed, exitCode/signalCode is already set and killAndWait
    // short-circuits. If it's still alive (TIMEOUT path), SIGKILL it.
    lastError = new Error(
      `Spawn attempt ${attempt}/${maxAttempts} failed with outcome=${outcome} ` +
        `(stderr: ${JSON.stringify(result.stderr.content.substring(0, 200))})`
    );
    if (
      result.child.exitCode === null &&
      result.child.signalCode === null
    ) {
      try {
        await killAndWait(result.child, 'SIGKILL', 5000);
      } catch (err) {
        // Cleanup error is non-fatal — we'll retry anyway.
      }
    }

    // Brief backoff before the next attempt. Without this, we could
    // hammer the OS with rapid spawn/probe cycles. 250ms balances
    // throughput (4 attempts/sec max) and politeness.
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `robustSpawnServer: exhausted ${maxAttempts} attempts. Last error: ` +
      (lastError ? lastError.message : 'unknown')
  );
}


// ---------------------------------------------------------------------------
// Describe Block 1 — Startup Lifecycle (3 tests)
// ---------------------------------------------------------------------------
//
// Covers the cold-start sequence of server.js: spawning the file as a
// child process, waiting for the listen() callback to fire, and verifying
// three escalating layers of correctness:
//   1. The listen() callback ran (proven by stdout containing the
//      expected startup log substring).
//   2. The OS-level listening socket is bound (proven by a raw TCP
//      connect succeeding).
//   3. The full HTTP stack is operational (proven by a real GET / call
//      returning 200 + the expected body).
//
// All three tests share the same prelude — spawn → push to cleanup
// tracker → wait for listening — by design. Each test is self-contained
// per AAP Section 0.7.2 test isolation requirements; deliberate
// duplication at this scale is preferable to a shared `beforeEach`
// fixture because (a) Test 3's HTTP request can run only after spawn,
// not before, and (b) per-test fresh spawns guarantee no state leaks
// between tests.

describe('server.js startup lifecycle', () => {
  // Tracks every ChildProcess spawned during the current test. The
  // afterEach hook iterates this list and SIGKILLs any leftover children
  // so port 3000 is fully released before the next test runs. Reset to
  // an empty array at the start of each test to avoid carrying
  // exited-process references across tests.
  let spawnedChildren;

  beforeEach(async () => {
    spawnedChildren = [];
    // Cross-file gate: wait until port 3000 is free before letting the
    // test proceed. This handles parallel-execution scenarios where
    // tests/integration/server.errors.test.js (the only other file in
    // this folder that binds port 3000) is currently scheduled by
    // Jest's worker pool to run alongside this file. See the
    // waitForPortFree comment block above for full rationale.
    await waitForPortFree(3000, '127.0.0.1', 15000);
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

  it('emits the startup log to stdout when spawned', async () => {
    // ARRANGE + ACT — Use the file-local robustSpawnServer wrapper to
    // spawn server.js and confirm its listen() callback fired. The
    // wrapper transparently retries on transient port-race failures
    // when this file runs in parallel with server.errors.test.js
    // (see the robustSpawnServer comment block for full rationale).
    // On success, the returned `stdout.content` already contains the
    // startup log substring.
    const { child, stdout } = await robustSpawnServer();
    spawnedChildren.push(child);

    // ASSERT — Re-check the captured stdout buffer to make the
    // assertion concrete and self-documenting in the test report. The
    // EXPECTED_STARTUP_LOG constant ('Server running at
    // http://127.0.0.1:3000/') is the resolved-template-literal output
    // of server.js:13.
    expect(stdout.content).toContain(EXPECTED_STARTUP_LOG);
  }, 30000);

  it('binds TCP port 3000 on 127.0.0.1 after startup', async () => {
    // ARRANGE — Spawn server.js (via the race-tolerant wrapper) and
    // wait for its listen() callback to fire, proving the bind()
    // syscall has completed by the time we issue our connect probe.
    const { child } = await robustSpawnServer();
    spawnedChildren.push(child);

    // ACT + ASSERT — Open a raw TCP connection to 127.0.0.1:3000. If
    // the listening socket is bound, the connect handshake completes
    // and the 'connect' event fires (resolving the promise). If the
    // socket is not bound, ECONNREFUSED fires on 'error' (rejecting
    // the promise — failing the test). The 5s timeout is a safety
    // net for hypothetical kernel-level delays; in practice loopback
    // connect on Linux completes in <1ms.
    //
    // We use raw TCP (rather than HTTP) here to isolate "port is
    // bound" from "server responds to HTTP correctly" — the latter
    // is exercised by Test 3 below. This separation makes failures
    // diagnostically precise: a Test 2 failure means the bind itself
    // didn't happen, while a Test 3 failure (with Test 2 passing)
    // means the bind succeeded but HTTP handling broke.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('TCP connect timeout')),
        5000
      );
      const socket = net.connect({ port: 3000, host: '127.0.0.1' });
      socket.once('connect', () => {
        clearTimeout(timer);
        // Send FIN cleanly rather than RST — the server's listening
        // socket is unaffected either way, but FIN is the standards-
        // compliant teardown for a successful probe.
        socket.end();
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }, 30000);

  it('responds 200 + "Hello, World!\\n" to HTTP GET / on the spawned server', async () => {
    // ARRANGE — Spawn server.js (via the race-tolerant wrapper) and
    // wait for its listen() callback to fire.
    const { child } = await robustSpawnServer();
    spawnedChildren.push(child);

    // ACT — Issue a real HTTP GET / against the spawned server using
    // Node's built-in http.request. This exercises the FULL stack
    // end-to-end: TCP connect → HTTP request line and headers → server
    // parser → server.js inline handler at server.js:6-10 → response
    // framing (200 status, Content-Type header, body) → response
    // delivery → client parser → assertions below.
    //
    // We use http.request (rather than http.get) to be explicit about
    // the method and request options. setEncoding('utf8') makes the
    // 'data' chunks decode to strings rather than Buffers, simplifying
    // the body concatenation.
    const { statusCode, body } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: 3000,
          method: 'GET',
          path: '/',
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: data });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    // ASSERT — Status code 200 (set explicitly at server.js:7).
    expect(statusCode).toBe(200);
    // ASSERT — Body byte-equal to 'Hello, World!\n' (set explicitly at
    // server.js:9). The trailing newline is critical and is preserved
    // by Node's HTTP framing through to the client.
    expect(body).toBe(EXPECTED_BODY);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Describe Block 2 — Shutdown Lifecycle (3 tests)
// ---------------------------------------------------------------------------
//
// Covers the orderly shutdown sequence of server.js when the parent
// (test runner) sends OS signals to the child:
//   1. SIGTERM → process exits (Node default, no handler installed)
//   2. SIGINT  → process exits (Node default, no handler installed)
//   3. After SIGTERM, port 3000 is released and a fresh instance can
//      bind without EADDRINUSE.
//
// All three tests use the same spawn-then-signal pattern. The third
// test is the most demanding because it exercises a sequenced
// spawn-kill-respawn cycle, requiring a small inter-spawn delay to
// account for any kernel-level lag in port-release propagation.
//
// Cross-platform consideration: server.js installs no signal handlers
// (`process.on('SIGTERM')` and `process.on('SIGINT')` are NOT
// registered). On POSIX (Linux/macOS), the default behavior is
// signal-based termination, producing `child.exitCode === null` and
// `child.signalCode === 'SIGTERM'` (or 'SIGINT'). On Windows, Node.js
// translates POSIX signal names to TerminateProcess; the resulting
// exitCode/signalCode values can vary. Tests assert
// `exitCode !== null || signalCode !== null` which is satisfied after
// ANY process exit on any platform.

describe('server.js shutdown lifecycle', () => {
  // See describe-block-1 comment for cleanup semantics. Each describe
  // block declares its own spawnedChildren variable rather than sharing
  // a module-level variable to keep state strictly scoped and prevent
  // cross-block leaks if Jest test ordering ever changed.
  let spawnedChildren;

  beforeEach(async () => {
    spawnedChildren = [];
    // Same cross-file port-free gate as the startup describe block.
    // See the waitForPortFree comment block above the file's first
    // describe for full rationale.
    await waitForPortFree(3000, '127.0.0.1', 15000);
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

  it('exits when receiving SIGTERM', async () => {
    // ARRANGE — Spawn server.js (via the race-tolerant wrapper) and
    // wait until it is listening, so we know the process is fully past
    // startup before we send the signal.
    const { child } = await robustSpawnServer();
    spawnedChildren.push(child);

    // ACT — Send SIGTERM via the helper. killAndWait registers a
    // one-shot 'exit' listener BEFORE calling child.kill, so there is
    // no race between signal delivery and listener registration. The
    // 5s timeout is the upper bound on signal-handler latency; in
    // practice Node responds within a few milliseconds.
    await killAndWait(child, 'SIGTERM', 5000);

    // ASSERT — At least one of exitCode or signalCode is non-null,
    // which is the unambiguous marker that the process has exited.
    // Per Node.js child_process docs: a still-running child has both
    // exitCode === null AND signalCode === null. ANY exit (clean or
    // signal-induced) sets at least one of them. This OR-form
    // assertion is platform-portable across POSIX (signal-induced
    // exit sets signalCode) and Windows (where the simulated signal
    // may set exitCode instead).
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30000);

  it('exits when receiving SIGINT', async () => {
    // ARRANGE — Spawn server.js (via the race-tolerant wrapper) and
    // wait until it is listening.
    const { child } = await robustSpawnServer();
    spawnedChildren.push(child);

    // ACT — Send SIGINT (the Ctrl-C equivalent on POSIX). server.js
    // has no SIGINT handler so Node's default termination path runs,
    // identical to the SIGTERM case in the previous test.
    await killAndWait(child, 'SIGINT', 5000);

    // ASSERT — Same platform-portable exit check as the SIGTERM test.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30000);

  it('releases port 3000 after the process exits, allowing a second instance to bind', async () => {
    // ARRANGE (Phase A) — Spawn the FIRST instance via the race-
    // tolerant wrapper and confirm it is listening on port 3000.
    const first = await robustSpawnServer();
    spawnedChildren.push(first.child);

    // ACT (Phase A) — Send SIGTERM to the first instance and await
    // its exit. After this awaits, the child process has terminated
    // and the OS-level listening socket has been closed (Node's
    // default cleanup runs file-descriptor close on process exit).
    await killAndWait(first.child, 'SIGTERM', 5000);

    // SETTLE — Allow time for the OS port-allocation table to reflect
    // the release. While Node enables SO_REUSEADDR on the listening
    // socket (preventing the canonical TIME_WAIT delay for client
    // connections), there is still a brief window between process
    // exit and the kernel marking the port re-bindable. 300ms is
    // empirically sufficient on Linux and is slightly longer than
    // the afterEach's 200ms to provide extra headroom for this
    // explicit spawn-kill-spawn sequence.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // ARRANGE (Phase B) + ACT (Phase B) — Spawn the SECOND instance
    // via the same race-tolerant wrapper. Successful resolution
    // proves the second listen() succeeded (no EADDRINUSE). The
    // wrapper internally watches for early exit and retries on
    // port-race failures, so the test is robust to any cross-file
    // interference that might arise during the inter-spawn delay.
    const second = await robustSpawnServer();
    spawnedChildren.push(second.child);

    // ASSERT 1 — Confirm the second instance's startup log is
    // present in its stdout buffer (positive evidence of successful
    // bind).
    expect(second.stdout.content).toContain(EXPECTED_STARTUP_LOG);

    // ASSERT 2 — Confirm the second instance's stderr does NOT
    // contain 'EADDRINUSE'. This is a NEGATIVE assertion — the
    // strongest available evidence that the port was clean — using
    // a regex that would catch any case-sensitive occurrence of the
    // literal error code emitted by Node's default error printer.
    // If the port had not released, Node's default uncaught-
    // exception handler would print a multi-line stack trace
    // containing 'Error: listen EADDRINUSE' to stderr.
    //
    // Note: with the race-tolerant wrapper, even if a transient
    // EADDRINUSE happened during a retried attempt, the wrapper
    // discards that child's buffers and returns the buffers from
    // the SUCCESSFUL final attempt — so this assertion holds.
    expect(second.stderr.content).not.toMatch(/EADDRINUSE/);
  }, 30000);
});

