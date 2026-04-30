/**
 * Jest Test Runner Configuration
 *
 * Single source of truth for Jest 30.x configuration in this repository.
 * Controls test discovery, exclusion of misleadingly-named files,
 * test environment selection, coverage collection settings, coverage
 * thresholds, and per-test timeout.
 *
 * This file lives at the repository root so the Jest CLI auto-discovers
 * it on `npm test` invocation. CommonJS module syntax is used to match
 * the rest of the project (see server.js: `const http = require('http');`).
 *
 * @see AAP Section 0.5.4 — Test Configuration Updates
 * @see AAP Section 0.7.1 — Coverage Configuration in jest.config.js
 * @see AAP Section 0.10.1 — Style and Convention (CommonJS, 2-space, single quotes)
 */
module.exports = {
  // Run tests in a Node.js environment (not jsdom).
  // The subject server.js is a Node HTTP server; tests never run in a browser.
  testEnvironment: 'node',

  // Restrict test discovery to the dedicated tests/ directory tree.
  // Prevents accidental matching of Test.test..js at the repo root, which
  // is a byte-equivalent copy of server.js and would bind port 3000 if
  // executed by Jest.
  testMatch: ['<rootDir>/tests/**/*.test.js'],

  // Defense-in-depth: explicitly ignore Test.test..js even if testMatch
  // were ever loosened. Also ignore node_modules (Jest's default, listed
  // explicitly for clarity).
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/Test.test..js'],

  // Measure coverage only on the subject under test. Excludes test
  // helpers, server-variant duplicates (Test.test..js, !@#$%^&().js,
  // long-name server file), and the test files themselves.
  collectCoverageFrom: ['server.js'],

  // Coverage report output directory (matched by .gitignore `coverage/`).
  coverageDirectory: 'coverage',

  // Multiple reporter formats to support local inspection, CI logs,
  // external coverage services, and badge generation.
  //   - text          → console summary table visible in CI logs
  //   - lcov          → coverage/lcov.info for Coveralls / Codecov
  //   - html          → coverage/lcov-report/index.html (browsable)
  //   - json-summary  → coverage/coverage-summary.json (machine-readable)
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],

  // Quality gating: Jest exits with a non-zero status if these thresholds
  // are not met when coverage is collected. Per AAP Section 0.7.1:
  //   - statements ≥ 95%  (≈ 10 executable statements in server.js)
  //   - branches   ≥ 90%  (minimal branching in handler)
  //   - functions  = 100% (request listener + listen callback both reached)
  //   - lines      ≥ 95%  (all 15 lines reachable via combined unit + lifecycle)
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 90,
      functions: 100,
      lines: 95,
    },
  },

  // Print each individual test result in console output for visibility
  // into pass/fail per assertion.
  verbose: true,

  // 30-second per-test timeout to accommodate slow CI environments and
  // the spawn-based integration tests that wait for OS signal handling.
  testTimeout: 30000,

  // Force sequential execution of test files (single Jest worker).
  // Required because tests/integration/server.lifecycle.test.js and
  // tests/integration/server.errors.test.js both spawn server.js as
  // a child process binding 127.0.0.1:3000. Without sequential
  // execution, Jest's default worker pool runs the two files in
  // parallel, producing intermittent EADDRINUSE-induced test
  // failures as the two workers race for the single bindable port.
  //
  // This setting is equivalent to passing the `--runInBand` CLI flag
  // and is preferred here so that the standard `npm test` invocation
  // (which is `jest --watchAll=false --ci` per AAP Section 0.9.1)
  // produces deterministic results without requiring users or CI
  // pipelines to remember the extra flag.
  //
  // Performance impact: unit tests now run sequentially as well,
  // adding ~150ms total overhead. Total `npm test` wall time is
  // ~7-9 seconds, well within the 60-second target from AAP
  // Section 0.7.2.
  maxWorkers: 1,
};
