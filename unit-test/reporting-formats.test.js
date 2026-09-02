const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { getTestLogs } = require('../build/javascript-agent-playwright/helpers');

const sourceFile = path.join(__dirname, 'fixtures', 'reporting-format-source.txt');
const location = path.relative(process.cwd(), sourceFile);
const testId = 77;

const steps = [
  {
    title: 'complete the synthetic order',
    category: 'test.step',
    startTime: new Date(1_000),
    duration: 250,
    location: { file: sourceFile, line: 1, column: 1 },
    steps: [
      {
        title: 'Fill "Ada Lovelace" locator("#customer")',
        category: 'pw:api',
        startTime: new Date(1_050),
        duration: 42,
        location: { file: sourceFile, line: 2, column: 1 },
        steps: [],
      },
      {
        title: 'Expect "toHaveText" locator("#result")',
        category: 'expect',
        startTime: new Date(1_100),
        duration: 18,
        location: { file: sourceFile, line: 3, column: 1 },
        steps: [],
      },
    ],
  },
];

const actions = [
  {
    id: 'probe-pass',
    kind: 'playwright',
    method: 'probe.waitUntilReady',
    params: { selector: '#reporting-probe', timeoutMs: 2_000 },
    startedAt: 2_000,
    endedAt: 2_180,
    status: 'passed',
    source: { file: sourceFile, line: 1, column: 1 },
  },
  {
    id: 'probe-fail',
    kind: 'playwright',
    method: 'probe.waitUntilReady',
    params: { selector: '#reporting-probe', timeoutMs: 300 },
    startedAt: 3_000,
    endedAt: 3_300,
    status: 'failed',
    source: { file: sourceFile, line: 1, column: 1 },
    error: 'ProbeNotReadyError: #reporting-probe was not ready after 300ms',
  },
  {
    id: 'probe-timeout',
    kind: 'playwright',
    method: 'probe.waitUntilReady',
    startedAt: 4_000,
    endedAt: 14_000,
    status: 'failed',
    error: 'Test timed out while executing this action. Test timeout of 10000ms exceeded.',
  },
];

const commonOptions = {
  ignorePlaywrightSteps: false,
  includeHooks: true,
  includeFixtures: true,
  includeBridgeActions: true,
  includeDuration: true,
  includeLocation: true,
  maxSourceLines: 3,
  maxMessageLength: 8_000,
  onlyCompletedSteps: false,
};

const expected = {
  structured: [
    {
      timestamp: 1_000,
      level: 'INFO',
      message: `complete the synthetic order [250ms]\n  source: await test.step('complete the synthetic order');\n  at: ${location}:1:1`,
    },
    {
      timestamp: 1_050,
      level: 'INFO',
      message: `  Fill "Ada Lovelace" locator("#customer") [42ms]\n    source: await page.locator('#customer').fill('Ada Lovelace');\n    at: ${location}:2:1`,
    },
    {
      timestamp: 1_100,
      level: 'INFO',
      message: `  Expect locator("#result") to have text 'submitted:Ada Lovelace' [18ms]\n    source: await expect(page.locator('#result')).toHaveText('submitted:Ada Lovelace');\n    at: ${location}:3:1`,
    },
    {
      timestamp: 2_000,
      level: 'INFO',
      message: `probe.waitUntilReady [180ms]\n  params: {"selector":"#reporting-probe","timeoutMs":2000}\n  at: ${location}:1:1`,
    },
    {
      timestamp: 3_000,
      level: 'ERROR',
      message: `probe.waitUntilReady [300ms]\n  params: {"selector":"#reporting-probe","timeoutMs":300}\n  at: ${location}:1:1\n  error: ProbeNotReadyError: #reporting-probe was not ready after 300ms`,
    },
    {
      timestamp: 4_000,
      level: 'ERROR',
      message: 'probe.waitUntilReady [10000ms]\n  error: Test timed out while executing this action. Test timeout of 10000ms exceeded.',
    },
  ],
  'playwright-title': [
    { timestamp: 1_000, level: 'INFO', message: 'complete the synthetic order' },
    { timestamp: 1_050, level: 'INFO', message: '  Fill "Ada Lovelace" locator("#customer")' },
    {
      timestamp: 1_100,
      level: 'INFO',
      message: '  Expect locator("#result") to have text \'submitted:Ada Lovelace\'',
    },
    { timestamp: 2_000, level: 'INFO', message: 'probe.waitUntilReady' },
    {
      timestamp: 3_000,
      level: 'ERROR',
      message: 'probe.waitUntilReady\n  error: ProbeNotReadyError: #reporting-probe was not ready after 300ms',
    },
    {
      timestamp: 4_000,
      level: 'ERROR',
      message: 'probe.waitUntilReady\n  error: Test timed out while executing this action. Test timeout of 10000ms exceeded.',
    },
  ],
  'source-line': [
    { timestamp: 1_000, level: 'INFO', message: "await test.step('complete the synthetic order');" },
    {
      timestamp: 1_050,
      level: 'INFO',
      message: "  await page.locator('#customer').fill('Ada Lovelace');",
    },
    {
      timestamp: 1_100,
      level: 'INFO',
      message: "  await expect(page.locator('#result')).toHaveText('submitted:Ada Lovelace');",
    },
    { timestamp: 2_000, level: 'INFO', message: 'probe.waitUntilReady' },
    {
      timestamp: 3_000,
      level: 'ERROR',
      message: 'probe.waitUntilReady\n  error: ProbeNotReadyError: #reporting-probe was not ready after 300ms',
    },
    {
      timestamp: 4_000,
      level: 'ERROR',
      message: 'probe.waitUntilReady\n  error: Test timed out while executing this action. Test timeout of 10000ms exceeded.',
    },
  ],
};

for (const format of Object.keys(expected)) {
  test(`${format} has exact user-visible text, levels, indentation, and timing`, () => {
    const actual = getTestLogs(steps, testId, { ...commonOptions, format }, actions).map(
      ({ timestamp, level, message }) => ({ timestamp, level, message }),
    );
    assert.deepEqual(actual, expected[format]);
    assert.deepEqual(
      actual.map((entry) => entry.timestamp),
      [...actual.map((entry) => entry.timestamp)].sort((left, right) => left - right),
    );
  });
}
