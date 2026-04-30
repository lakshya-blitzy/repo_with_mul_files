/**
 * tests/unit/server.headers.test.js
 *
 * HTTP response header unit tests for server.js.
 *
 * Verifies that every HTTP response emitted by server.js carries the
 * correct headers — both the single explicitly-set header
 * (`Content-Type: text/plain` from server.js:8) and the auto-generated
 * headers contributed by Node.js's `http` module (`Connection`, `Date`,
 * `Content-Length`).
 *
 * Single describe block (matching AAP Section 0.5.2 "1 describe block"):
 *   - server.js HTTP response headers — explicit + auto-generated header
 *     assertions, case-insensitive accessor convention, header value
 *     normalization
 *
 * Total: 8 tests (within AAP Section 0.5.2 target range of 6-8 tests).
 *
 * Architectural Constraints (per AAP Section 0.10.1):
 *   - CommonJS only (`require()` to match server.js style)
 *   - 2-space indentation, single-quote string literals, trailing semicolons
 *   - No `'use strict'` directive (server.js does not use one)
 *   - No `require('../../server.js')` — uses createEquivalentHandler() to
 *     avoid the immediate `server.listen(3000, ...)` side effect that
 *     would conflict with parallel Jest workers and integration tests
 *   - Parallel-safe: Supertest binds to an OS-assigned ephemeral port
 *
 * Critical insight on Node.js header normalization:
 *   Node.js's HTTP module's `IncomingMessage.headers` object always
 *   stores header names in LOWERCASE, regardless of the case used by
 *   the server when calling `res.setHeader()`. Supertest preserves
 *   this convention, so `response.headers['Content-Type']` returns
 *   `undefined` while `response.headers['content-type']` returns the
 *   value. Test 6 explicitly verifies this normalization invariant.
 *
 * Critical insight on Content-Length vs Transfer-Encoding:
 *   When `res.end(body)` is called with a known-size string body and
 *   no explicit Content-Length was set, Node.js auto-calculates and
 *   sets Content-Length to `Buffer.byteLength(body)`. In this mode,
 *   Transfer-Encoding: chunked is NOT used (the two are mutually
 *   exclusive per HTTP/1.1). Tests therefore assert Content-Length
 *   presence and value, but do not assert Transfer-Encoding presence.
 *
 * Critical insight on Date and Connection headers:
 *   - Date is RFC 7231-formatted but its value depends on test
 *     execution time; tests assert presence and type only.
 *   - Connection's value is `'close'` or `'keep-alive'` depending on
 *     HTTP version and Supertest connection-pooling behavior; tests
 *     assert presence and type only, not exact value.
 *
 * @see AAP Section 0.1.3 — Technical Interpretation
 * @see AAP Section 0.4.2 — Test Case Blueprint
 * @see AAP Section 0.5.1 — File-by-File Test Plan (row 3)
 * @see AAP Section 0.5.2 — New Test Files Detail
 * @see AAP Section 0.10.1 — User-Specified Testing Directives
 */

const request = require('supertest');
const {
  createEquivalentHandler,
  EXPECTED_BODY,
  EXPECTED_CONTENT_TYPE,
} = require('../helpers/serverHelper');

// ---------------------------------------------------------------------------
// Describe Block — server.js HTTP response headers
// ---------------------------------------------------------------------------
//
// All tests in this block share a single pre-bound http.Server instance
// listening on an OS-assigned ephemeral port. Pre-binding (rather than
// letting Supertest auto-listen per request) is consistent with the
// pattern established in tests/unit/server.edgeCases.test.js and avoids
// per-request listen/close overhead. Each test issues an independent HTTP
// request — there is no shared mutable state between tests, and no test
// depends on the order of execution.
// ---------------------------------------------------------------------------

describe('server.js HTTP response headers', () => {
  let server;

  beforeAll((done) => {
    // Construct a fresh http.Server whose request listener is byte-
    // equivalent to server.js:6-10. The created server is non-listening
    // until we call `server.listen(0, ...)`, where port 0 instructs the
    // OS to assign any available ephemeral port (avoiding conflict with
    // the hard-coded port 3000 that the real server.js would bind, and
    // avoiding conflict with parallel Jest workers).
    server = createEquivalentHandler();
    server.listen(0, done);
  });

  afterAll((done) => {
    // Release the ephemeral port and free the underlying file descriptor.
    // The `server.listening` guard defends against double-close from
    // unexpected upstream cleanup, and the `done()` fallback ensures
    // Jest does not hang if the server was never bound.
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  // -------------------------------------------------------------------------
  // Test 1 — Explicit Content-Type header value
  // -------------------------------------------------------------------------
  //
  // Verifies the single explicit `res.setHeader('Content-Type', 'text/plain')`
  // call at server.js:8. The header value must be exactly 'text/plain' with
  // no auto-appended charset parameter (Node.js, unlike Express, does NOT
  // add `; charset=utf-8` for setHeader). Lowercase key access is used per
  // Node.js's IncomingMessage.headers normalization convention.
  // -------------------------------------------------------------------------

  it('sets Content-Type to "text/plain" exactly', async () => {
    const response = await request(server).get('/');
    expect(response.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Content-Type via Supertest's fluent header matcher
  // -------------------------------------------------------------------------
  //
  // Exercises Supertest's `.expect('<header>', /<regex>/)` API, which is
  // distinct from the post-response object inspection used in Test 1.
  // Supertest matches the header NAME case-insensitively (locating
  // 'Content-Type' even though Node stores it as 'content-type') and
  // matches the VALUE against the supplied regex. The `/text\/plain/`
  // regex tolerates any optional charset parameters that a future
  // server.js modification might introduce, while still failing if the
  // primary media type changes.
  // -------------------------------------------------------------------------

  it('emits "text/plain" Content-Type using Supertest header expectation', async () => {
    await request(server).get('/').expect('Content-Type', /text\/plain/);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Connection header presence (auto-generated)
  // -------------------------------------------------------------------------
  //
  // Node.js's HTTP module auto-emits a Connection header whose value
  // depends on protocol version and connection-pooling state ('close' for
  // HTTP/1.0 or one-shot connections; 'keep-alive' for HTTP/1.1 persistent
  // connections). Because Supertest's exact behavior may vary across
  // versions and platforms, this test asserts only PRESENCE and TYPE,
  // not an exact value — preventing test flakiness while still verifying
  // the header is emitted.
  // -------------------------------------------------------------------------

  it('emits a "Connection" header (auto-generated by Node.js http module)', async () => {
    const response = await request(server).get('/');
    expect(response.headers).toHaveProperty('connection');
    expect(typeof response.headers.connection).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Test 4 — Date header presence (auto-generated)
  // -------------------------------------------------------------------------
  //
  // Node.js auto-emits a Date header on every response, formatted per
  // RFC 7231 §7.1.1.2 (e.g., 'Tue, 15 Nov 1994 08:12:31 GMT'). The value
  // is necessarily non-deterministic (it changes every second of wall-
  // clock time), so this test asserts only PRESENCE and TYPE. Asserting
  // an exact value would produce a flaky test.
  // -------------------------------------------------------------------------

  it('emits a "Date" header (auto-generated by Node.js http module)', async () => {
    const response = await request(server).get('/');
    expect(response.headers).toHaveProperty('date');
    expect(typeof response.headers.date).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Test 5 — Content-Length matches body byte length
  // -------------------------------------------------------------------------
  //
  // server.js calls `res.end('Hello, World!\n')` at line 9 with a known-
  // size string body. Because no explicit Content-Length was set and no
  // Transfer-Encoding: chunked was requested, Node.js auto-calculates
  // Content-Length as `Buffer.byteLength(body)`. The expected value is
  // the byte length of EXPECTED_BODY (14 bytes for 'Hello, World!\n')
  // serialized as a string (HTTP header values are strings).
  //
  // This test cross-validates server.js:9 (`res.end('Hello, World!\n')`)
  // and Node.js's auto-Content-Length calculation by deriving the
  // expected length from the same EXPECTED_BODY constant the server uses.
  // -------------------------------------------------------------------------

  it('emits a "Content-Length" header matching the body byte length', async () => {
    const response = await request(server).get('/');
    expect(response.headers).toHaveProperty('content-length');
    const expectedLength = Buffer.byteLength(EXPECTED_BODY).toString();
    expect(response.headers['content-length']).toBe(expectedLength);
  });

  // -------------------------------------------------------------------------
  // Test 6 — Case-insensitive (lowercase) header lookup convention
  // -------------------------------------------------------------------------
  //
  // Node.js's HTTP module normalizes ALL incoming header names to
  // lowercase in the IncomingMessage.headers object. Supertest preserves
  // this convention: regardless of how the server emitted the header
  // ('Content-Type' via setHeader at server.js:8), the response.headers
  // map exposes it under the lowercase key 'content-type' ONLY.
  //
  // Direct uppercase access (response.headers['Content-Type']) returns
  // undefined — verifying that consumer code MUST use lowercase keys.
  // This is a critical convention for Node.js HTTP code.
  // -------------------------------------------------------------------------

  it('exposes Content-Type header via case-insensitive (lowercase) access', async () => {
    const response = await request(server).get('/');
    expect(response.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
    expect(response.headers['Content-Type']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 7 — Multiple headers in response object
  // -------------------------------------------------------------------------
  //
  // Verifies that server.js's response includes at least three distinct
  // headers: the explicit Content-Type plus at least two auto-generated
  // headers (Date, Connection, and/or Content-Length). The threshold of
  // 3 is a conservative lower bound — actual responses typically include
  // 4+ headers — but using a >= comparison rather than === avoids
  // brittleness if Node.js adds or removes auto-headers in future
  // versions. Asserts the canonical 'content-type' key is present.
  // -------------------------------------------------------------------------

  it('returns response with at least three headers (Content-Type plus auto-generated)', async () => {
    const response = await request(server).get('/');
    const headerKeys = Object.keys(response.headers);
    expect(headerKeys.length).toBeGreaterThanOrEqual(3);
    expect(headerKeys).toContain('content-type');
  });

  // -------------------------------------------------------------------------
  // Test 8 — Content-Type value has no leading/trailing whitespace
  // -------------------------------------------------------------------------
  //
  // RFC 9110 §5.5 specifies that header field values are subject to
  // optional whitespace (OWS) trimming on both sides. server.js sets
  // Content-Type to the literal 'text/plain' (no surrounding whitespace
  // at server.js:8), and Node.js does not add any. This test verifies
  // that the as-emitted header value equals its trimmed form, guarding
  // against any future regression that might inadvertently introduce
  // whitespace into the literal.
  // -------------------------------------------------------------------------

  it('emits Content-Type with no leading or trailing whitespace', async () => {
    const response = await request(server).get('/');
    expect(response.headers['content-type']).toBe(
      response.headers['content-type'].trim()
    );
    expect(response.headers['content-type']).not.toMatch(/^\s|\s$/);
  });
});
