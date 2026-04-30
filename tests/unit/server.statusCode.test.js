/**
 * tests/unit/server.statusCode.test.js
 *
 * HTTP status code unit tests for server.js.
 *
 * Verifies that server.js emits HTTP `200 OK` UNIFORMLY for every
 * incoming request, regardless of HTTP method or URL path. The line
 * under primary test focus is server.js:7 — `res.statusCode = 200;` —
 * which sets the status code unconditionally inside the inline request
 * handler. Because that handler performs zero method discrimination
 * and zero path routing, the entire request matrix (7 methods × N paths)
 * MUST collapse to a single observable outcome: 200 OK.
 *
 * Two describe blocks (matching AAP Section 0.5.2 "2 describe blocks"):
 *   1. HTTP method matrix — parameterized via Jest's `test.each` over
 *      the seven primary HTTP methods (GET, POST, PUT, DELETE, PATCH,
 *      HEAD, OPTIONS) sourced from the shared `HTTP_METHODS` constant
 *      in tests/helpers/serverHelper.js. Each iteration asserts
 *      `response.status === 200`, `response.statusCode === 200`, and
 *      Supertest's `response.statusType === 2` (2xx classification).
 *   2. URL path matrix — parameterized via `test.each` over four
 *      representative URL paths (`/`, `/hello`, `/api`, `/?q=1`)
 *      defined as a LOCAL constant `STATUS_PATHS` (intentionally
 *      narrower than the helper's `URL_PATHS` constant, which is
 *      tuned for edge-case testing with URL-encoded characters).
 *      Each iteration asserts `response.status === 200` and
 *      `response.statusType === 2`.
 *
 * Total: 11 tests (matches AAP Section 0.5.2 target range of 9-11 tests):
 *   - 7 from HTTP method matrix (one per method in HTTP_METHODS)
 *   - 4 from URL path matrix (one per path in STATUS_PATHS)
 *
 * Architectural Constraints (per AAP Section 0.10.1):
 *   - CommonJS only (`require()` to match server.js style)
 *   - 2-space indentation, single-quote string literals, trailing semicolons
 *   - No `'use strict'` directive (server.js does not use one)
 *   - No `require('../../server.js')` — uses createEquivalentHandler() to
 *     avoid the immediate `server.listen(3000, ...)` side effect that
 *     would conflict with parallel Jest workers and integration tests
 *   - Parallel-safe: Supertest's ephemeral port binding handles isolation
 *
 * Critical insight on Supertest dynamic method dispatch:
 *   The expression `request(server)[method.toLowerCase()](url)` works
 *   because SuperAgent (Supertest's underlying HTTP client) exposes
 *   each HTTP method as a lowercase function on its request prototype:
 *   `.get`, `.post`, `.put`, `.delete`, `.patch`, `.head`, `.options`.
 *   This pattern lets a single `test.each` callback drive all 7 methods
 *   without a switch statement or hard-coded method dispatch.
 *
 * Critical insight on response.statusType:
 *   Supertest exposes a numeric `statusType` property on the response
 *   object, computed as `Math.floor(status / 100)`. For a 200 response,
 *   `statusType === 2`. Asserting on `statusType` adds an extra layer
 *   of verification that the response falls in the 2xx range, not
 *   just exactly 200 — defending against future server.js changes that
 *   might emit 201, 204, etc. and would correctly remain "successful".
 *
 * @see AAP Section 0.1.3 — Technical Interpretation
 * @see AAP Section 0.4.2 — Test Case Blueprint (status code matrix)
 * @see AAP Section 0.5.1 — File-by-File Test Plan (row 2)
 * @see AAP Section 0.5.2 — New Test Files Detail (this file)
 * @see AAP Section 0.10.1 — User-Specified Testing Directives
 */

const request = require('supertest');
const {
  createEquivalentHandler,
  HTTP_METHODS,
} = require('../helpers/serverHelper');

// ---------------------------------------------------------------------------
// Describe Block 1 — HTTP method matrix (parameterized over HTTP_METHODS)
// ---------------------------------------------------------------------------
//
// Asserts that every one of the seven primary HTTP methods produces a
// uniform 200 OK status code when targeting the root path `/`. The
// uniformity reflects server.js's lack of method-discrimination logic:
// the inline handler sets `res.statusCode = 200` (server.js:7) before
// inspecting the request method, so all methods produce identical
// status outcomes. This block uses Jest's `test.each` to drive 7
// individual tests from the single `HTTP_METHODS` array.
//
// Lifecycle (matches AAP Phase 3 Task Checklist):
//   - beforeAll constructs a fresh non-listening http.Server via
//     `createEquivalentHandler()`. Supertest will auto-listen on an
//     ephemeral port for each individual request, then auto-close the
//     server after the response. This is sufficient for sequential
//     awaited requests (which is what each test in this block does)
//     and avoids the need for explicit `server.listen(0, done)`.
//   - afterAll defensively closes the server only if it remains
//     listening (Supertest may or may not have left it bound depending
//     on the timing of the final test's response handling).
// ---------------------------------------------------------------------------

describe('server.js HTTP status code — HTTP method matrix', () => {
  let server;

  beforeAll(() => {
    // Construct a fresh http.Server whose request listener is byte-
    // equivalent to server.js:6-10. The server is NOT started here;
    // Supertest will auto-listen on an OS-assigned ephemeral port for
    // each request, avoiding any conflict with the hard-coded port
    // 3000 that the real server.js would bind, and avoiding conflict
    // with parallel Jest workers running other test files.
    server = createEquivalentHandler();
  });

  afterAll((done) => {
    // Defensive cleanup — release the underlying socket if Supertest
    // left the server in a listening state. The `server.listening`
    // guard prevents calling `close()` on an already-closed server
    // (which would throw `ERR_SERVER_NOT_RUNNING`). The `else done()`
    // branch ensures Jest does not hang waiting for an unfired callback
    // when the server is not currently bound.
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  // -------------------------------------------------------------------------
  // Parameterized test — one iteration per method in HTTP_METHODS.
  // -------------------------------------------------------------------------
  //
  // The `%s` placeholder in the test title is replaced by Jest with the
  // current iteration's method string, producing distinct test names:
  //   - `returns 200 OK for GET /`
  //   - `returns 200 OK for POST /`
  //   - `returns 200 OK for PUT /`
  //   - `returns 200 OK for DELETE /`
  //   - `returns 200 OK for PATCH /`
  //   - `returns 200 OK for HEAD /`
  //   - `returns 200 OK for OPTIONS /`
  //
  // Inside the callback, the method string is lowercased to match
  // SuperAgent's prototype function names (e.g., `request(server).get`,
  // `request(server).delete`). Bracket notation is required because
  // the method name is dynamic; it cannot be resolved with dot notation.
  //
  // Three assertions per test (matches AAP "Assertion focus"):
  //   - response.status     → primary status (Supertest convenience alias)
  //   - response.statusCode → underlying http.IncomingMessage.statusCode
  //   - response.statusType → Math.floor(status / 100) — 2 for 2xx
  // -------------------------------------------------------------------------

  test.each(HTTP_METHODS)('returns 200 OK for %s /', async (method) => {
    const lowerMethod = method.toLowerCase();
    const response = await request(server)[lowerMethod]('/');

    // Primary assertion: exact status code 200.
    // Supertest's `response.status` is the canonical accessor; it
    // mirrors the `res.statusCode` property set at server.js:7.
    expect(response.status).toBe(200);

    // Secondary assertion: `statusCode` is Supertest's alternative
    // accessor for the same value (both are exposed for compatibility
    // with different naming conventions). Asserting both guards
    // against any future Supertest version that might diverge them.
    expect(response.statusCode).toBe(200);

    // Tertiary assertion: 2xx classification. Supertest computes
    // `statusType` as the leading digit of the status code, so any
    // 2xx response (200, 201, 202, ...) yields `statusType === 2`.
    // This adds defense-in-depth: even if a future change emits
    // 204 No Content for HEAD (per RFC), the 2xx classification
    // assertion would still pass — but Test 1's exact-200 assertion
    // would correctly fail and force conscious test maintenance.
    expect(response.statusType).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Describe Block 2 — URL path matrix (parameterized over STATUS_PATHS)
// ---------------------------------------------------------------------------
//
// Asserts that varied URL paths all produce 200 OK status codes,
// reflecting server.js's lack of routing logic — the inline handler
// runs unconditionally for every URL the server receives. This block
// uses Jest's `test.each` to drive 4 individual tests from a LOCAL
// `STATUS_PATHS` array (intentionally narrower than the helper's
// global `URL_PATHS` constant, which is tuned for edge-case testing
// with URL-encoded characters and longer multi-segment paths).
//
// The 4 paths chosen represent four classes of URL targeting:
//   - `/`        → root (smallest possible path)
//   - `/hello`   → simple sub-path (no query string, no special chars)
//   - `/api`     → another simple sub-path (different first segment)
//   - `/?q=1`    → root with query string (verifies query parsing
//                  doesn't alter the response)
//
// Lifecycle: identical to Block 1 (independent server instance per
// describe block to maintain test isolation guarantees).
// ---------------------------------------------------------------------------

describe('server.js HTTP status code — URL path matrix', () => {
  let server;

  // Local path matrix — kept LOCAL to this describe block (rather than
  // imported from the helper's URL_PATHS) because the AAP Section 0.5.2
  // specifies a different path set for status code tests than for edge
  // case tests. Edge case tests use URL-encoded paths to stress the
  // URL parser; status code tests use plain paths to focus solely on
  // the absence of routing.
  const STATUS_PATHS = ['/', '/hello', '/api', '/?q=1'];

  beforeAll(() => {
    // Fresh server instance for this describe block. Per-block
    // isolation means a failure in Block 1 cannot affect Block 2's
    // server state, even though both blocks construct equivalent
    // handlers from the same factory.
    server = createEquivalentHandler();
  });

  afterAll((done) => {
    // Defensive cleanup mirroring Block 1's pattern.
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  // -------------------------------------------------------------------------
  // Parameterized test — one iteration per path in STATUS_PATHS.
  // -------------------------------------------------------------------------
  //
  // The `%s` placeholder in the test title is replaced by Jest with
  // the current iteration's path string, producing distinct test names:
  //   - `returns 200 OK for GET /`
  //   - `returns 200 OK for GET /hello`
  //   - `returns 200 OK for GET /api`
  //   - `returns 200 OK for GET /?q=1`
  //
  // GET is fixed as the request method here (path variation is the
  // axis being tested); the method matrix axis is covered by Block 1.
  // Asserting both `status` and `statusType` provides exact-value and
  // 2xx-classification verification per AAP "Assertions focus".
  // -------------------------------------------------------------------------

  test.each(STATUS_PATHS)('returns 200 OK for GET %s', async (urlPath) => {
    const response = await request(server).get(urlPath);

    // Primary assertion: exact status code 200, demonstrating that the
    // server emits 200 regardless of which path was requested.
    expect(response.status).toBe(200);

    // Secondary assertion: 2xx classification. As in Block 1, this is
    // a robust check that the response is in the success range.
    expect(response.statusType).toBe(2);
  });
});
