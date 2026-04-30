/**
 * tests/unit/server.edgeCases.test.js
 *
 * HTTP edge case unit tests for server.js.
 *
 * Exercises boundary conditions of the inline request handler at
 * server.js:6-10. Because that handler performs zero discrimination on
 * method, path, headers, or request body — it unconditionally writes
 * `200 OK`, `Content-Type: text/plain`, and `'Hello, World!\n'` for every
 * request — these tests verify the ABSENCE of routing, method-specific
 * behavior, and payload sensitivity, while also stress-testing concurrent
 * and sequential request handling.
 *
 * Three describe blocks (matching AAP Section 0.5.2 "2-3 describe blocks"):
 *   1. HTTP method peculiarities (HEAD body suppression per RFC 7231,
 *      HEAD/GET header parity, OPTIONS uniformity)
 *   2. URL paths and request payloads (query strings, URL-encoded
 *      special characters, large request bodies, custom request headers)
 *   3. Concurrent and sequential load (10 concurrent, 100 sequential,
 *      mixed-method concurrency)
 *
 * Total: 10 tests (within AAP Section 0.5.2 target range of 8-10 tests).
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
 * Critical insight on HEAD response body:
 *   server.js's handler calls `res.end('Hello, World!\n')` unconditionally,
 *   but Node.js's HTTP module respects RFC 7231 §4.3.2 and DROPS the body
 *   for HEAD responses while preserving the headers (including
 *   Content-Type and Content-Length). Tests therefore assert
 *   `expect(response.text).toBeFalsy()` (handles both '' and undefined)
 *   for HEAD body and `toBe(EXPECTED_CONTENT_TYPE)` for HEAD headers.
 *
 * @see AAP Section 0.4.2 — Test Case Blueprint
 * @see AAP Section 0.5.1 — File-by-File Test Plan (row 4)
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
// Describe Block 1 — HTTP method peculiarities
// ---------------------------------------------------------------------------
//
// Verifies behavior of HTTP methods with protocol-mandated peculiarities:
//   - HEAD: Body must be suppressed by Node.js per RFC 7231 even though
//     the handler writes 'Hello, World!\n'. Headers must still be set.
//   - OPTIONS: No CORS or method-discrimination logic in server.js, so
//     OPTIONS receives the same 200 + body as GET.
// ---------------------------------------------------------------------------

describe('server.js edge cases — HTTP method peculiarities', () => {
  let server;

  beforeAll((done) => {
    // Bind the server to an OS-assigned ephemeral port (port 0) BEFORE
    // any test runs. This is critical for the concurrent-request tests
    // in Block 3: when Supertest receives a non-listening server it
    // auto-starts AND auto-closes the server per request, which races
    // catastrophically under Promise.all (the first completing request
    // closes the socket while others are still in-flight, producing
    // `read ECONNRESET`). By pre-starting the server, Supertest sees
    // `server.address()` is non-null on every call and skips its
    // listen/close lifecycle management — the same listening socket
    // services every request in the describe block.
    server = createEquivalentHandler();
    server.listen(0, done);
  });

  afterAll((done) => {
    // Release the ephemeral port and free underlying file descriptors.
    // The `server.listening` guard ensures `close` is only called on a
    // currently-listening server (defensive against double-close from
    // unexpected upstream cleanup).
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it('returns empty body for HEAD / (per RFC 7231)', async () => {
    // Even though server.js:9 unconditionally calls
    // `res.end('Hello, World!\n')`, Node.js's HTTP module suppresses the
    // body for HEAD responses per RFC 7231 §4.3.2. Supertest's
    // `response.text` may be '' or undefined depending on parser
    // behavior; toBeFalsy() handles both cases robustly.
    const response = await request(server).head('/');
    expect(response.status).toBe(200);
    expect(response.text).toBeFalsy();
  });

  it('returns same headers for HEAD as for GET', async () => {
    // RFC 7231 §4.3.2 mandates that HEAD responses include the same
    // header fields the server would have sent for an equivalent GET
    // request. Verify Content-Type matches between HEAD and GET, and
    // that both equal the EXPECTED_CONTENT_TYPE constant ('text/plain').
    const headRes = await request(server).head('/');
    const getRes = await request(server).get('/');
    expect(headRes.headers['content-type']).toBe(getRes.headers['content-type']);
    expect(headRes.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
  });

  it('returns 200 for OPTIONS / (no method discrimination)', async () => {
    // server.js performs no CORS handling and no method-based routing.
    // OPTIONS therefore receives the same 200 + 'Hello, World!\n' body
    // as any other method.
    const response = await request(server).options('/');
    expect(response.status).toBe(200);
    expect(response.text).toBe(EXPECTED_BODY);
  });
});

// ---------------------------------------------------------------------------
// Describe Block 2 — URL paths and request payloads
// ---------------------------------------------------------------------------
//
// Verifies behavior across the URL path matrix and request payload matrix:
//   - Query strings (the `?key=value` portion is part of req.url but
//     server.js never reads req.url)
//   - URL-encoded special characters (e.g., '%20' for spaces — Node.js's
//     HTTP parser accepts them as-is; server.js does not decode the path)
//   - Large request bodies (server.js never reads the request body, so
//     large payloads should be silently ignored without crash)
//   - Custom request headers (server.js never reads request headers, so
//     arbitrary client-supplied headers should not affect the response)
// ---------------------------------------------------------------------------

describe('server.js edge cases — URL paths and request payloads', () => {
  let server;

  beforeAll((done) => {
    // Pre-bind the server to an ephemeral port (see Block 1 comment for
    // detailed rationale). Although this block contains no concurrent
    // tests, we use the same setup pattern uniformly across all three
    // describe blocks for consistency and future-proofing.
    server = createEquivalentHandler();
    server.listen(0, done);
  });

  afterAll((done) => {
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it('returns 200 + body for path with query string (/?query=string)', async () => {
    // Query strings are a standard URL component; server.js does not
    // parse req.url, so the response is identical to a request for '/'.
    const response = await request(server).get('/?query=string');
    expect(response.status).toBe(200);
    expect(response.text).toBe(EXPECTED_BODY);
  });

  it('returns 200 + body for path with URL-encoded special characters', async () => {
    // '%20' is the percent-encoded representation of a space character.
    // Node.js's HTTP parser does not decode the path before passing it
    // to req.url; server.js ignores req.url entirely, so the response
    // is unchanged.
    const response = await request(server).get('/path%20with%20spaces');
    expect(response.status).toBe(200);
    expect(response.text).toBe(EXPECTED_BODY);
  });

  it('returns 200 + body for POST with large JSON body (server ignores body)', async () => {
    // Build a ~10 KB JSON payload. Supertest's `.send(object)` serializes
    // it as JSON and sets Content-Type and Content-Length headers
    // automatically. server.js never attaches a 'data' or 'end' listener
    // to the request stream, so the body is buffered in the kernel/socket
    // and discarded when the response completes. This test verifies the
    // server does not crash, hang, or alter its response under a non-
    // trivial request payload.
    const largeBody = { data: 'x'.repeat(10000) };
    const response = await request(server).post('/').send(largeBody);
    expect(response.status).toBe(200);
    expect(response.text).toBe(EXPECTED_BODY);
  });

  it('returns 200 + body when request includes custom headers', async () => {
    // server.js never reads req.headers, so arbitrary client-supplied
    // headers (X-Custom-Header, X-Another-Header, etc.) have no effect
    // on the response. The expected output is the uniform 200 + body.
    const response = await request(server)
      .get('/')
      .set('X-Custom-Header', 'test-value')
      .set('X-Another-Header', 'another-value');
    expect(response.status).toBe(200);
    expect(response.text).toBe(EXPECTED_BODY);
  });
});

// ---------------------------------------------------------------------------
// Describe Block 3 — Concurrent and sequential load
// ---------------------------------------------------------------------------
//
// Stress-tests the server's ability to handle parallel and burst traffic:
//   - 10 concurrent GET requests (parallelism via Promise.all)
//   - 100 sequential GET requests (no resource leak / no degradation)
//   - Mixed concurrent multi-method requests (parallel handling across
//     different HTTP methods and paths)
// ---------------------------------------------------------------------------

describe('server.js edge cases — concurrent and sequential load', () => {
  let server;

  beforeAll((done) => {
    // CRITICAL: Pre-bind the server to an ephemeral port. This block
    // contains concurrent-request tests (10 parallel requests, mixed-
    // method parallelism). Without pre-binding, Supertest's per-request
    // listen/close lifecycle would race under Promise.all and produce
    // `read ECONNRESET` errors as the first completing request closes
    // the server out from under the others. Pre-binding lets Supertest
    // skip its lifecycle management — it sees the server already has
    // an address and reuses it across every concurrent request.
    server = createEquivalentHandler();
    server.listen(0, done);
  });

  afterAll((done) => {
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it('handles 10 concurrent GET / requests, all returning 200 + body', async () => {
    // Promise.all initiates all 10 requests "simultaneously" (within a
    // single microtask tick), then awaits all of them. Supertest
    // multiplexes the requests over the same listening server. Node.js's
    // event loop and the http.Server's connection handling must process
    // all 10 concurrently and produce identical responses.
    const promises = Array.from({ length: 10 }, () => request(server).get('/'));
    const responses = await Promise.all(promises);
    expect(responses).toHaveLength(10);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.text).toBe(EXPECTED_BODY);
    }
  });

  it('handles 100 sequential GET / requests, all returning 200 + body', async () => {
    // Sequential burst: 100 requests issued one-after-another with await.
    // On modern hardware over loopback, this completes in ~1-3 seconds,
    // well within Jest's 30-second testTimeout (configured in
    // jest.config.js per AAP Section 0.5.4). The test verifies the
    // server does not degrade or leak resources (file descriptors,
    // memory, etc.) over a sustained request stream.
    for (let i = 0; i < 100; i++) {
      const response = await request(server).get('/');
      expect(response.status).toBe(200);
      expect(response.text).toBe(EXPECTED_BODY);
    }
  });

  it('handles a mix of concurrent GET, POST, PUT, DELETE requests', async () => {
    // Concurrent mixed-method requests verify that parallel handling
    // works uniformly across HTTP verbs and paths. server.js's lack of
    // routing means all five requests should produce identical
    // 200 + body responses regardless of method or path.
    const responses = await Promise.all([
      request(server).get('/'),
      request(server).post('/'),
      request(server).put('/'),
      request(server).delete('/'),
      request(server).get('/api'),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.text).toBe(EXPECTED_BODY);
    }
  });
});
