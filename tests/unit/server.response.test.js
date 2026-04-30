/**
 * tests/unit/server.response.test.js
 *
 * HTTP response BODY unit tests for server.js.
 *
 * Verifies that the inline request handler at server.js:6-10 produces
 * the EXACT 14-byte response body `'Hello, World!\n'` regardless of
 * which HTTP method delivered the request. The line under primary test
 * focus is server.js:9 — `res.end('Hello, World!\n');` — which writes
 * the response payload unconditionally inside the handler. Because the
 * handler performs zero method discrimination, every method (GET, POST,
 * PUT, DELETE, PATCH, etc.) MUST produce the same body bytes.
 *
 * Two describe blocks (matching AAP Section 0.5.2 "1-2 describe blocks"):
 *   1. GET request body assertions — three byte-level invariants on the
 *      response payload returned for `GET /` (exact string equality,
 *      14-byte length, trailing newline preservation).
 *   2. Non-GET method body assertions — four parallel tests confirming
 *      that POST, PUT, DELETE, and PATCH each return the identical
 *      `'Hello, World!\n'` body, demonstrating that server.js performs
 *      no method discrimination.
 *
 * Total: 7 tests (within AAP Section 0.5.2 target range of 5-7 tests):
 *   - 3 tests in describe block 1 (GET request body invariants)
 *   - 4 tests in describe block 2 (non-GET method body uniformity)
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
 * Critical insight on Supertest body decoding:
 *   When the response Content-Type is `text/plain` (as set by
 *   server.js:8), Supertest exposes the decoded UTF-8 string body via
 *   the `response.text` property — NOT `response.body`. The latter is
 *   reserved for parsed bodies (JSON, urlencoded, etc.) and would be
 *   `{}` (empty object) or `Buffer` for text/plain. All assertions in
 *   this file therefore target `response.text` for byte-string checks.
 *
 * Critical insight on the 14-byte length:
 *   `'Hello, World!\n'` decomposes to: 'H','e','l','l','o',',',' ','W',
 *   'o','r','l','d','!','\n' = 14 ASCII characters = 14 UTF-8 bytes.
 *   The trailing `\n` (LF, ASCII 10) is REQUIRED — its presence is the
 *   most easily-corrupted invariant (e.g., trim()-style middleware
 *   could silently strip it). Test 3 explicitly verifies this byte.
 *
 * Critical insight on `.send({...})` for POST:
 *   Supertest's `.send(obj)` serializes the object as JSON and sets the
 *   request `Content-Type: application/json` header. The current
 *   server.js handler ignores the request body entirely (it never reads
 *   `req`), so even with a JSON request body, the response remains the
 *   identical `'Hello, World!\n'`. The POST test thereby double-verifies
 *   robustness against unexpected client-supplied request bodies.
 *
 * @see AAP Section 0.1.3 — Technical Interpretation (HTTP response body)
 * @see AAP Section 0.4.2 — Test Case Blueprint (server.js HTTP request handler)
 * @see AAP Section 0.5.1 — File-by-File Test Plan (row 1)
 * @see AAP Section 0.5.2 — New Test Files Detail (this file)
 * @see AAP Section 0.10.1 — User-Specified Testing Directives
 */

const request = require('supertest');
const {
  createEquivalentHandler,
  EXPECTED_BODY,
} = require('../helpers/serverHelper');

// ---------------------------------------------------------------------------
// Describe Block 1 — GET request body invariants
// ---------------------------------------------------------------------------
//
// Asserts three byte-level invariants on the response payload returned
// for `GET /`:
//   1. Exact string equality with EXPECTED_BODY ('Hello, World!\n')
//   2. UTF-8 byte length is exactly 14
//   3. Trailing newline (LF, ASCII 10) is present and is the LAST byte
//
// Lifecycle (matches AAP Phase 3 Task Checklist):
//   - beforeAll constructs a fresh non-listening http.Server via
//     `createEquivalentHandler()`. Supertest will auto-listen on an
//     OS-assigned ephemeral port for each individual request, then
//     auto-close the server after the response settles. This avoids
//     any conflict with the hard-coded port 3000 that the real
//     server.js would bind.
//   - afterAll defensively closes the server only if it remains
//     listening, releasing the underlying socket resource. The
//     `server.listening` guard prevents calling `close()` on an
//     already-closed server (which would throw `ERR_SERVER_NOT_RUNNING`).
//     The `else done()` branch ensures Jest does not hang waiting for
//     an unfired callback when the server is not currently bound.
// ---------------------------------------------------------------------------

describe('server.js HTTP response body — GET requests', () => {
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
  // Test 1 — Byte-exact equality with EXPECTED_BODY
  // -------------------------------------------------------------------------
  //
  // Verifies that the response body returned for `GET /` is BYTE-FOR-BYTE
  // identical to the EXPECTED_BODY constant ('Hello, World!\n', 14 bytes).
  // This is the most direct verification of server.js:9
  // (`res.end('Hello, World!\n');`) — any deviation (extra/missing bytes,
  // changed characters, dropped newline) causes this assertion to fail.
  //
  // Single assertion: `expect(response.text).toBe(EXPECTED_BODY)`.
  // Jest's `.toBe` uses Object.is (effectively `===` for primitives),
  // so this check is strict equality without coercion or whitespace
  // tolerance — exactly the byte-level fidelity required.
  // -------------------------------------------------------------------------

  it('returns the exact "Hello, World!\\n" body for GET /', async () => {
    const response = await request(server).get('/');
    expect(response.text).toBe(EXPECTED_BODY);
  });

  // -------------------------------------------------------------------------
  // Test 2 — UTF-8 byte length is exactly 14
  // -------------------------------------------------------------------------
  //
  // Verifies that `Buffer.byteLength(response.text, 'utf8')` equals 14.
  // Because `'Hello, World!\n'` is pure ASCII (a UTF-8 subset where
  // every code point fits in a single byte), the string's character
  // count equals its UTF-8 byte count. This is a defense-in-depth
  // check that complements Test 1 — it would catch any subtle Unicode
  // corruption (e.g., BOM injection, encoding mismatch) that might
  // pass byte-string equality but alter byte length.
  //
  // Single assertion: `expect(Buffer.byteLength(...)).toBe(14)`.
  // The explicit 'utf8' encoding argument is included for clarity even
  // though it is the default — making the test self-documenting about
  // which encoding is being measured.
  // -------------------------------------------------------------------------

  it('returns a body of exactly 14 bytes (Buffer byteLength)', async () => {
    const response = await request(server).get('/');
    expect(Buffer.byteLength(response.text, 'utf8')).toBe(14);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Trailing newline character preservation
  // -------------------------------------------------------------------------
  //
  // Verifies that the response body ends with the LF newline (`\n`,
  // ASCII code 10). The trailing newline is the most easily-corrupted
  // invariant of `'Hello, World!\n'` — common pitfalls include:
  //   - HTTP middleware that auto-trims response bodies
  //   - String concatenation that drops trailing whitespace
  //   - Accidental `'Hello, World!'` (no `\n`) in a refactor
  //
  // Two assertions complement each other:
  //   - `endsWith('\n')` is high-readability — communicates intent
  //   - `charCodeAt(length - 1) === 10` is byte-level — guards against
  //     pathological cases where `\n` is replaced by a Unicode
  //     line-separator (U+2028, code 8232) or carriage return (CR,
  //     code 13) that visually appears as a newline but is a different
  //     code point.
  //
  // Two assertions in this single test stays within the AAP "1-3
  // assertions per test" guideline.
  // -------------------------------------------------------------------------

  it('preserves the trailing newline character in the response body', async () => {
    const response = await request(server).get('/');
    expect(response.text.endsWith('\n')).toBe(true);
    expect(response.text.charCodeAt(response.text.length - 1)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Describe Block 2 — Non-GET method body uniformity
// ---------------------------------------------------------------------------
//
// Asserts that POST, PUT, DELETE, and PATCH all return the identical
// `'Hello, World!\n'` body, reflecting server.js's lack of method
// discrimination. The inline handler at server.js:6-10 never inspects
// `req.method`, so every method produces the same byte-for-byte
// response payload. These four tests exercise the four most common
// non-GET methods used by REST APIs, and their uniform pass status
// proves the server is method-agnostic.
//
// HEAD and OPTIONS are intentionally NOT tested in this block — their
// HTTP-protocol-mandated semantics (HEAD returns headers without body
// per RFC 7231 §4.3.2; OPTIONS may include CORS pre-flight semantics)
// are covered by `tests/unit/server.edgeCases.test.js`. This block
// focuses solely on the method-uniformity invariant for body content.
//
// Lifecycle: identical to Block 1 (independent server instance per
// describe block to maintain test isolation guarantees — a failure or
// state change in Block 1 cannot affect Block 2).
// ---------------------------------------------------------------------------

describe('server.js HTTP response body — non-GET methods', () => {
  let server;

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
  // Test 1 — POST / returns "Hello, World!\n" body (with JSON request body)
  // -------------------------------------------------------------------------
  //
  // POST is the most common non-GET method and typically carries a
  // request body (form data, JSON payload, etc.). Supertest's
  // `.send(obj)` serializes the argument as JSON and sets the
  // `Content-Type: application/json` request header — simulating a
  // realistic JSON-API client.
  //
  // server.js's handler never reads `req`, so the JSON body is
  // completely ignored. This test thereby double-verifies:
  //   - Method uniformity (POST yields same body as GET)
  //   - Robustness against unexpected client-supplied request bodies
  //     (server does not crash, does not hang, does not leak request
  //     body data into the response)
  //
  // Single assertion: byte-string equality of the response body.
  // -------------------------------------------------------------------------

  it('returns "Hello, World!\\n" body for POST /', async () => {
    const response = await request(server).post('/').send({ data: 'ignored' });
    expect(response.text).toBe(EXPECTED_BODY);
  });

  // -------------------------------------------------------------------------
  // Test 2 — PUT / returns "Hello, World!\n" body
  // -------------------------------------------------------------------------
  //
  // PUT is the canonical method for resource creation/replacement in
  // REST APIs. server.js does not implement REST semantics, so PUT is
  // expected to produce the same uniform `'Hello, World!\n'` body.
  // No request body is sent (PUT is functionally indistinguishable
  // from GET in this server's response).
  //
  // Single assertion: byte-string equality of the response body.
  // -------------------------------------------------------------------------

  it('returns "Hello, World!\\n" body for PUT /', async () => {
    const response = await request(server).put('/');
    expect(response.text).toBe(EXPECTED_BODY);
  });

  // -------------------------------------------------------------------------
  // Test 3 — DELETE / returns "Hello, World!\n" body
  // -------------------------------------------------------------------------
  //
  // DELETE is the canonical method for resource removal in REST APIs.
  // server.js does not implement REST semantics, so DELETE is expected
  // to produce the same uniform `'Hello, World!\n'` body. This is
  // particularly noteworthy because some HTTP servers/frameworks
  // return 204 No Content (empty body) for DELETE by default —
  // server.js does NOT do this, instead returning the standard body.
  //
  // Single assertion: byte-string equality of the response body.
  // -------------------------------------------------------------------------

  it('returns "Hello, World!\\n" body for DELETE /', async () => {
    const response = await request(server).delete('/');
    expect(response.text).toBe(EXPECTED_BODY);
  });

  // -------------------------------------------------------------------------
  // Test 4 — PATCH / returns "Hello, World!\n" body
  // -------------------------------------------------------------------------
  //
  // PATCH is the canonical method for partial resource updates in
  // REST APIs (RFC 5789). server.js does not implement REST semantics,
  // so PATCH is expected to produce the same uniform `'Hello, World!\n'`
  // body. PATCH is included alongside PUT/DELETE/POST to cover the
  // four most commonly-used non-GET methods.
  //
  // Single assertion: byte-string equality of the response body.
  // -------------------------------------------------------------------------

  it('returns "Hello, World!\\n" body for PATCH /', async () => {
    const response = await request(server).patch('/');
    expect(response.text).toBe(EXPECTED_BODY);
  });
});
