const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Reporter = require('../build/javascript-agent-playwright/ZebrunnerReporter').default;
const { EVENT_NAMES } = require('../build/javascript-agent-playwright/constants/events');
const { ReportingConfig } = require('../build/javascript-agent-playwright/ReportingConfig');
const {
  buildTestIdentity,
  determineLogLevel,
  formatFailureReason,
  getTestLogs,
  normalizeAttemptLabels,
  parseReporterEvent,
  prepareAttemptArtifacts,
  sanitizeLogMessage,
  sanitizeTelemetryValue,
  stripTerminalCodes,
} = require('../build/javascript-agent-playwright/helpers');

const makeTest = (nested = false) => {
  const root = { title: '', type: 'root' };
  const project = {
    title: 'iphone-16-plus',
    type: 'project',
    parent: root,
    project: () => ({ name: 'iphone-16-plus' }),
  };
  const file = {
    title: 'specs/locator-input.spec.js',
    type: 'file',
    parent: project,
    project: project.project,
  };
  const describe = {
    title: 'keyboard API',
    type: 'describe',
    parent: file,
    project: project.project,
  };
  return {
    _projectId: 'iphone-16-plus',
    title: 'inserts text',
    parent: nested ? describe : file,
  };
};

const structuredOptions = {
  ignorePlaywrightSteps: false,
  includeHooks: false,
  includeFixtures: false,
  includeBridgeActions: true,
  format: 'structured',
  includeDuration: true,
  includeLocation: true,
  maxSourceLines: 4,
  maxMessageLength: 8000,
};

test('builds root and nested test identities without duplicating the project', () => {
  assert.deepEqual(buildTestIdentity(makeTest()), {
    name: 'iphone-16-plus > specs/locator-input.spec.js > inserts text',
    className: 'specs/locator-input.spec.js',
    methodName: 'inserts text',
    projectName: 'iphone-16-plus',
    suitePath: 'specs/locator-input.spec.js',
  });
  assert.equal(
    buildTestIdentity(makeTest(true)).name,
    'iphone-16-plus > specs/locator-input.spec.js > keyboard API > inserts text',
  );
  const sameTitle = makeTest(true);
  sameTitle._projectId = undefined;
  sameTitle.parent.title = 'iphone-16-plus';
  assert.equal(
    buildTestIdentity(sameTitle).name,
    'iphone-16-plus > specs/locator-input.spec.js > iphone-16-plus > inserts text',
  );
});

test('maps skipped attempts to INFO and failures to ERROR', () => {
  assert.equal(determineLogLevel('passed'), 'INFO');
  assert.equal(determineLogLevel('skipped'), 'INFO');
  assert.equal(determineLogLevel('failed'), 'ERROR');
  assert.equal(determineLogLevel('timedOut'), 'ERROR');
  assert.equal(determineLogLevel('interrupted'), 'ERROR');
});

test('formats failure text once when the stack already contains the message', () => {
  const failure = formatFailureReason({
    message: 'Expected pasted',
    stack: 'Error: Expected pasted\n    at locator-input.spec.js:247:43',
  });
  assert.equal(failure.match(/Expected pasted/g).length, 1);
});

test('recognizes only known reporter events', () => {
  assert.equal(parseReporterEvent('{"ordinary":"json"}'), null);
  assert.deepEqual(
    parseReporterEvent(JSON.stringify({ eventType: EVENT_NAMES.ATTACH_TEST_LOG, payload: { message: 'ok' } })),
    { eventType: EVENT_NAMES.ATTACH_TEST_LOG, payload: { message: 'ok' } },
  );
});

test('disabled reporter records results without initializing remote reporting state', async () => {
  const reporter = new Reporter();
  const pwTest = {
    ...makeTest(),
    id: 'disabled-test',
    expectedStatus: 'passed',
    retries: 0,
  };
  const result = {
    retry: 0,
    status: 'passed',
    duration: 5,
    startTime: new Date(),
    stdout: [],
    stderr: [],
    steps: [],
    attachments: [],
  };
  const output = [];
  const restoreLog = console.log;
  console.log = (line) => output.push(String(line));
  try {
    await reporter.onBegin(
      {
        reporter: [
          ['/tmp/javascript-agent-playwright/index.js', { enabled: false }],
          ['json', {}],
        ],
      },
      { allTests: () => [pwTest] },
    );
    await reporter.onTestEnd(pwTest, result);
    await reporter.onEnd({ status: 'passed' });
  } finally {
    console.log = restoreLog;
  }

  assert.deepEqual(reporter.resultStats, { passed: 1 });
  assert.ok(output.some((line) => line.includes('1 passed')));
});

test('merges structured action start and finish events by action id', () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: { ignoreConsole: true, ignoreCustom: false, ignoreManualScreenshots: false },
  };
  reporter.pwTestIdToCapabilities = new Map();
  const pwTest = { id: 'action-test', title: 'action events' };
  const result = { retry: 0, startTime: new Date(), stdout: [], stderr: [], steps: [], attachments: [] };
  const started = {
    id: 'action-1',
    kind: 'bridge',
    method: 'page.bridge.getSessionId',
    params: { detail: true },
    startedAt: 10,
    status: 'started',
  };
  reporter.handleStdOutChunk(
    JSON.stringify({ eventType: EVENT_NAMES.ATTACH_TEST_ACTION, payload: started }),
    pwTest,
    result,
  );
  reporter.handleStdOutChunk(
    JSON.stringify({
      eventType: EVENT_NAMES.ATTACH_TEST_ACTION,
      payload: {
        id: started.id,
        kind: started.kind,
        method: started.method,
        startedAt: started.startedAt,
        endedAt: 20,
        status: 'passed',
      },
    }),
    pwTest,
    result,
  );
  assert.deepEqual(reporter.pwTestResultToState.get(result).actions, [
    { ...started, endedAt: 20, status: 'passed' },
  ]);
});

test('uses event time for custom logs and accepts console output before any Playwright step', () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: { ignoreConsole: false, ignoreCustom: false, ignoreManualScreenshots: false },
  };
  reporter.pwTestIdToCapabilities = new Map();
  const pwTest = { id: 'ordered-events', title: 'ordered events' };
  const result = { retry: 0, startTime: new Date(1_000), stdout: [], stderr: [], steps: [], attachments: [] };

  reporter.handleStdOutChunk('console before first step', pwTest, result);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].title, 'console before first step');
  assert.equal(result.steps[0].startTime.getTime() >= 1_000, true);

  reporter.handleStdOutChunk(
    JSON.stringify({
      eventType: EVENT_NAMES.ATTACH_TEST_LOG,
      payload: { message: 'after console', level: 'INFO', timestamp: 4_321 },
    }),
    pwTest,
    result,
  );
  assert.equal(result.steps[1].title, 'after console');
  assert.equal(result.steps[1].startTime.getTime(), 4_321);

  reporter.handleStdOutChunk(
    JSON.stringify({
      eventType: EVENT_NAMES.ATTACH_TEST_SCREENSHOT,
      payload: { pathOrBuffer: __filename, deleteAfterUpload: false, timestamp: 5_432 },
    }),
    pwTest,
    result,
  );
  assert.equal(result.steps[2].category, 'zebrunner:screenshot');
  assert.equal(result.steps[2].startTime.getTime(), 5_432);
});

test('keeps console output free of terminal escape sequences', () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: { ignoreConsole: false, ignoreCustom: false, ignoreManualScreenshots: false },
  };
  reporter.pwTestIdToCapabilities = new Map();
  const pwTest = { id: 'colored-console', title: 'colored console' };
  const result = { retry: 0, startTime: new Date(1_000), stdout: [], stderr: [], steps: [], attachments: [] };

  reporter.handleStdOutChunk('recording marker exists \u001b[33mfalse\u001b[39m', pwTest, result);
  reporter.handleStdOutChunk('\u001b[0m\u001b[2m\u001b[22m\u001b[0m', pwTest, result);

  assert.deepEqual(
    result.steps.map((step) => step.title),
    ['recording marker exists false'],
  );

  assert.equal(stripTerminalCodes('artifact dir [ \u001b[32m\'video.mp4\'\u001b[39m ]'), "artifact dir [ 'video.mp4' ]");
  assert.equal(stripTerminalCodes('\u001b]8;;https://zebrunner.com\u0007link\u001b]8;;\u0007'), 'link');
  assert.equal(stripTerminalCodes('progress\rdone\r\nnext\tcolumn'), 'progress\ndone\nnext\tcolumn');
  assert.equal(sanitizeLogMessage('\u001b[31mfailed\u001b[39m', 100), 'failed');
});

test('parses multiple framed reporter events from one stdout chunk in order', () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: { ignoreConsole: false, ignoreCustom: false, ignoreManualScreenshots: false },
  };
  reporter.pwTestIdToCapabilities = new Map();
  const pwTest = { id: 'framed-events', title: 'framed events' };
  const result = { retry: 0, startTime: new Date(1_000), stdout: [], stderr: [], steps: [], attachments: [] };
  const events = [
    { eventType: EVENT_NAMES.ATTACH_TEST_LOG, payload: { message: 'first', level: 'INFO', timestamp: 2_000 } },
    { eventType: EVENT_NAMES.ATTACH_TEST_LOG, payload: { message: 'second', level: 'WARN', timestamp: 3_000 } },
  ];

  reporter.onStdOut(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, pwTest, result);

  assert.deepEqual(result.steps.map((step) => step.title), ['first', 'second']);
  assert.deepEqual(result.steps.map((step) => step.startTime.getTime()), [2_000, 3_000]);
  assert.deepEqual(result.steps.map((step) => step.category), ['zebrunner:log:INFO', 'zebrunner:log:WARN']);
});

test('normalizes retry labels without attempt-scoped metadata', () => {
  assert.deepEqual(
    normalizeAttemptLabels(
      [
        { key: 'sessionId', value: 'first' },
        { key: 'sessionId', value: 'retry' },
        { key: 'attempt.2.sessionId', value: 'legacy' },
        { key: 'first-session-id', value: 'live' },
        { key: 'owner', value: 'old' },
        { key: 'owner', value: 'new' },
        { key: 'owner', value: 'new' },
      ],
      1,
    ),
    [
      { key: 'owner', value: 'old' },
      { key: 'owner', value: 'new' },
      { key: 'retries', value: '1' },
    ],
  );
  assert.deepEqual(normalizeAttemptLabels([{ key: 'sessionId', value: 'first' }], 0), []);
  assert.deepEqual(normalizeAttemptLabels([{ key: 'first-session-id', value: 'live' }], 0), []);
});

test('prefixes and deduplicates retry artifacts', () => {
  const artifact = {
    timestamp: 1,
    pathOrBuffer: '/tmp/bridge.log',
    name: 'bridge.log',
    fingerprint: 'same',
  };
  assert.deepEqual(prepareAttemptArtifacts([artifact, { ...artifact }], 1, true), [
    { ...artifact, name: 'attempt-2-bridge.log' },
  ]);
  assert.deepEqual(
    prepareAttemptArtifacts([{ timestamp: 2, pathOrBuffer: '/tmp/trace.zip' }], 0, true),
    [{ timestamp: 2, pathOrBuffer: '/tmp/trace.zip', name: 'attempt-1-trace.zip' }],
  );
  assert.equal(
    prepareAttemptArtifacts([artifact, { ...artifact, name: 'copy.log' }], 1, true).length,
    2,
  );
});

test('renders hierarchy, multiline source, duration, and location', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-logs-'));
  const sourcePath = path.join(dir, 'sample.spec.js');
  fs.writeFileSync(
    sourcePath,
    [
      "test.step('navigation', async () => {",
      '  await page.goto(',
      '    targetUrl,',
      "    { waitUntil: 'domcontentloaded' },",
      '  );',
      '});',
    ].join('\n'),
  );
  try {
    const startedAt = new Date();
    const logs = getTestLogs(
      [
        {
          title: 'navigation',
          category: 'test.step',
          startTime: startedAt,
          duration: 20,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [
            {
              title: 'Navigate to "/"',
              category: 'pw:api',
              startTime: new Date(startedAt.getTime() + 1),
              duration: 10,
              location: { file: sourcePath, line: 2, column: 3 },
              steps: [],
            },
          ],
        },
      ],
      7,
      structuredOptions,
    );
    assert.equal(logs.length, 2);
    assert.match(logs[0].message, /navigation \[20ms\]/);
    assert.match(logs[1].message, /await page\.goto\( targetUrl, \{ waitUntil: 'domcontentloaded' \},/);
    assert.match(logs[1].message, /sample\.spec\.js:2:3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releases source-file caching after each attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-source-cache-'));
  const sourcePath = path.join(dir, 'sample.spec.js');
  const steps = [
    {
      title: 'action',
      category: 'pw:api',
      startTime: new Date(),
      duration: 1,
      location: { file: sourcePath, line: 1, column: 1 },
      steps: [],
    },
  ];
  try {
    fs.writeFileSync(sourcePath, 'firstVersion();\n');
    assert.match(
      getTestLogs(steps, 7, { ...structuredOptions, format: 'source-line' })[0].message,
      /firstVersion/,
    );
    fs.writeFileSync(sourcePath, 'secondVersion();\n');
    assert.match(
      getTestLogs(steps, 7, { ...structuredOptions, format: 'source-line' })[0].message,
      /secondVersion/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('excludes hook, fixture, and internal hook actions by default', () => {
  const startedAt = Date.now();
  const steps = [
    {
      title: 'Fill "pasted" locator("#kbd-input")',
      category: 'pw:api',
      startTime: new Date(startedAt),
      duration: 20,
      steps: [],
    },
    {
      title: 'After Hooks',
      category: 'hook',
      startTime: new Date(startedAt + 100),
      duration: 100,
      steps: [
        {
          title: 'Fixture "page"',
          category: 'fixture',
          startTime: new Date(startedAt + 110),
          duration: 80,
          steps: [],
        },
        {
          title: 'Close context',
          category: 'pw:api',
          startTime: new Date(startedAt + 120),
          duration: 70,
          steps: [],
        },
      ],
    },
  ];
  const actions = [
    {
      id: 'internal-1',
      kind: 'bridge',
      method: 'page.bridge.isForeground',
      startedAt: startedAt + 115,
      endedAt: startedAt + 125,
      status: 'passed',
    },
  ];

  const defaultLogs = getTestLogs(steps, 7, structuredOptions, actions);
  assert.equal(defaultLogs.length, 1);
  assert.match(defaultLogs[0].message, /Fill "pasted"/);

  const verboseLogs = getTestLogs(
    steps,
    7,
    { ...structuredOptions, includeHooks: true, includeFixtures: true },
    actions,
  );
  assert.equal(verboseLogs.some((log) => /After Hooks/.test(log.message)), true);
  assert.equal(verboseLogs.some((log) => /Fixture "page"/.test(log.message)), true);
  assert.equal(verboseLogs.some((log) => /page\.bridge\.isForeground/.test(log.message)), true);
});

test('does not extend hook exclusion through long-lived fixture children', () => {
  const startedAt = Date.now();
  const logs = getTestLogs(
    [
      {
        title: 'Before Hooks',
        category: 'hook',
        startTime: new Date(startedAt),
        duration: 50,
        steps: [
          {
            title: 'Fixture "page"',
            category: 'fixture',
            startTime: new Date(startedAt),
            duration: 1000,
            steps: [],
          },
        ],
      },
      {
        title: 'Navigate to "/"',
        category: 'pw:api',
        startTime: new Date(startedAt + 100),
        duration: 20,
        steps: [],
      },
    ],
    7,
    structuredOptions,
    [
      {
        id: 'goto-fixture-overlap',
        kind: 'playwright',
        method: 'page.goto',
        params: { url: 'https://example.com/' },
        startedAt: startedAt + 90,
        endedAt: startedAt + 130,
        status: 'passed',
      },
    ],
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /Navigate to "https:\/\/example\.com\/"/);
  assert.doesNotMatch(logs[0].message, /Navigate to "\/"/);
});

test('omits wrapper-internal source and location for node_modules-located steps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-internal-loc-'));
  const bridgeProxy = path.join(dir, 'node_modules', 'ios-playwright-lib', 'src', 'bridge-proxy.js');
  fs.mkdirSync(path.dirname(bridgeProxy), { recursive: true });
  fs.writeFileSync(
    bridgeProxy,
    `${'// filler\n'.repeat(66)}      return recordAction('playwright', 'page.goto', params, () => original.apply(this, args));\n`,
  );
  try {
    const logs = getTestLogs(
      [
        {
          title: 'Navigate to "/"',
          category: 'pw:api',
          startTime: new Date(),
          duration: 10,
          location: { file: bridgeProxy, line: 67, column: 80 },
          steps: [],
        },
      ],
      7,
      structuredOptions,
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, 'Navigate to "/" [10ms]');
    assert.doesNotMatch(logs[0].message, /recordAction/);
    assert.doesNotMatch(logs[0].message, /bridge-proxy\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaces a lossy native navigation title with runtime action data', () => {
  const startedAt = Date.now();
  const logs = getTestLogs(
    [
      {
        title: 'Navigate to "/"',
        category: 'pw:api',
        startTime: new Date(startedAt + 1),
        duration: 10,
        steps: [],
      },
    ],
    8,
    structuredOptions,
    [
      {
        id: 'goto-1',
        kind: 'playwright',
        method: 'page.goto',
        params: { url: 'https://example.com/', options: { waitUntil: 'domcontentloaded' } },
        startedAt,
        endedAt: startedAt + 12,
        status: 'passed',
        source: { file: path.join(process.cwd(), 'test', 'sample.spec.js'), line: 4, column: 7 },
      },
    ],
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /Navigate to "https:\/\/example\.com\/" \[12ms\]/);
  assert.match(logs[0].message, /https:\/\/example\.com\//);
  assert.match(logs[0].message, /at: test\/sample\.spec\.js:4:7/);
});

test('uses concise human action names in playwright-title format', () => {
  const startedAt = Date.now();
  const logs = getTestLogs(
    [],
    8,
    { ...structuredOptions, format: 'playwright-title' },
    [
      {
        id: 'goto-title',
        kind: 'playwright',
        method: 'page.goto',
        params: { url: 'https://example.com/' },
        startedAt,
        endedAt: startedAt + 12,
        status: 'passed',
      },
    ],
  );
  assert.equal(logs[0].message, 'Navigate to "https://example.com/"');
});

test('suppresses only the native API step correlated to an overlapping action', () => {
  const startedAt = Date.now();
  const logs = getTestLogs(
    [
      {
        title: 'Evaluate',
        category: 'pw:api',
        startTime: new Date(startedAt + 1),
        duration: 2,
        steps: [],
      },
      {
        title: 'Click locator("#submit")',
        category: 'pw:api',
        startTime: new Date(startedAt + 2),
        duration: 3,
        steps: [],
      },
    ],
    8,
    structuredOptions,
    [
      {
        id: 'bridge-1',
        kind: 'bridge',
        method: 'page.bridge.acceptAlert',
        startedAt,
        endedAt: startedAt + 10,
        status: 'passed',
      },
    ],
  );
  assert.equal(logs.length, 2);
  assert.equal(logs.some((log) => /Click locator/.test(log.message)), true);
  assert.equal(logs.some((log) => /page\.bridge\.acceptAlert/.test(log.message)), true);
});

test('structured actions honor Playwright-step and duration settings', () => {
  const startedAt = Date.now();
  const logs = getTestLogs(
    [],
    8,
    { ...structuredOptions, ignorePlaywrightSteps: true, includeDuration: false },
    [
      {
        id: 'goto-1',
        kind: 'playwright',
        method: 'page.goto',
        startedAt,
        endedAt: startedAt + 10,
        status: 'passed',
      },
      {
        id: 'bridge-1',
        kind: 'bridge',
        method: 'page.bridge.acceptAlert',
        startedAt,
        endedAt: startedAt + 10,
        status: 'passed',
      },
    ],
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'page.bridge.acceptAlert');
  assert.equal(
    getTestLogs(
      [
        {
          title: 'Evaluate',
          category: 'pw:api',
          startTime: new Date(startedAt + 1),
          duration: 5,
          steps: [],
        },
      ],
      8,
      { ...structuredOptions, includeBridgeActions: false },
      [
        {
          id: 'bridge-2',
          kind: 'bridge',
          method: 'page.bridge.acceptAlert',
          startedAt,
          endedAt: startedAt + 10,
          status: 'passed',
        },
      ],
    ).length,
    0,
  );
});

test('renders custom assertion messages as matcher-based titles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-expect-title-'));
  const sourcePath = path.join(dir, 'sample.spec.js');
  fs.writeFileSync(sourcePath, "await expect(input, 'typed value').toHaveValue('hello');\n");
  try {
    const logs = getTestLogs(
      [
        {
          title: "typed value locator('#kbd-input')",
          category: 'expect',
          startTime: new Date(),
          duration: 1,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
      ],
      9,
      { ...structuredOptions, format: 'playwright-title' },
    );
    assert.equal(logs[0].message, "Expect locator('#kbd-input') to have value 'hello'");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not repeat Expect on page-level matcher titles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-expect-page-'));
  const sourcePath = path.join(dir, 'sample.spec.js');
  fs.writeFileSync(
    sourcePath,
    [
      'await expect(page).toHaveURL(/\\/docs\\//);',
      'await expect(page).toHaveTitle(/Playwright/);',
      "await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
      'await expect(gridSession.sessionId).toBeTruthy();',
      '',
    ].join('\n'),
  );
  try {
    const logs = getTestLogs(
      [
        {
          title: 'Expect "toHaveURL"',
          category: 'expect',
          startTime: new Date(1),
          duration: 1,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
        {
          title: 'Expect "toHaveTitle"',
          category: 'expect',
          startTime: new Date(2),
          duration: 1,
          location: { file: sourcePath, line: 2, column: 1 },
          steps: [],
        },
        {
          title: "Expect \"toBeVisible\" getByRole('heading', { level: 1 })",
          category: 'expect',
          startTime: new Date(3),
          duration: 1,
          location: { file: sourcePath, line: 3, column: 1 },
          steps: [],
        },
        {
          title: 'Expect "toBeTruthy"',
          category: 'expect',
          startTime: new Date(4),
          duration: 1,
          location: { file: sourcePath, line: 4, column: 1 },
          steps: [],
        },
      ],
      9,
      { ...structuredOptions, format: 'playwright-title' },
    );
    assert.deepEqual(
      logs.map((entry) => entry.message),
      [
        'Expect page to have url /\\/docs\\//',
        'Expect page to have title /Playwright/',
        "Expect getByRole('heading', { level: 1 }) to be visible",
        'Expect gridSession.sessionId to be truthy',
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const format of ['playwright-title', 'source-line']) {
  test(`${format} compatibility logs retain failure details`, () => {
    const logs = getTestLogs(
      [
        {
          title: 'failed action',
          category: 'pw:api',
          startTime: new Date(),
          duration: 1,
          steps: [],
          error: { message: 'failure detail', stack: 'Error: failure detail\n    at test.js:1:1' },
        },
      ],
      9,
      { ...structuredOptions, format },
    );
    assert.match(logs[0].message, /failure detail/);
  });
}

test('redacts sensitive values, handles circular data, and truncates messages', () => {
  const circular = {
    password: 'secret',
    access_token: 'hidden',
    big: 7n,
    url: 'https://example.com/?token=hidden',
  };
  circular.self = circular;
  assert.deepEqual(sanitizeTelemetryValue(circular), {
    password: '[REDACTED]',
    access_token: '[REDACTED]',
    big: '7',
    url: 'https://example.com/?token=[REDACTED]',
    self: '[Circular]',
  });
  assert.equal(sanitizeLogMessage('authorization: Bearer hidden', 100), 'authorization: [REDACTED]');
  assert.equal(sanitizeLogMessage('authorization: Basic dXNlcjpwYXNz', 100), 'authorization: [REDACTED]');
  assert.equal(sanitizeLogMessage('cookie: first=one; second=two', 100), 'cookie: [REDACTED]');
  assert.match(sanitizeLogMessage('x'.repeat(100), 30), /truncated/);
});

test('maps legacy source settings while defaulting new configurations to structured logs', () => {
  const defaults = new ReportingConfig({ enabled: false });
  assert.equal(defaults.logs.format, 'structured');
  assert.equal(defaults.logs.includeHooks, false);
  assert.equal(defaults.logs.includeFixtures, false);
  assert.equal(defaults.logs.includeBridgeActions, false);
  assert.equal(
    new ReportingConfig({ enabled: false, logs: { useLinesFromSourceCode: false } }).logs.format,
    'playwright-title',
  );
  assert.equal(
    new ReportingConfig({
      enabled: false,
      logs: { useLinesFromSourceCode: false, format: 'structured' },
    }).logs.format,
    'structured',
  );
});

test('finishes a test with the observed wall-clock end and deduplicated reason', async () => {
  const reporter = new Reporter();
  let request;
  reporter.apiClient = {
    finishTest: async (_launchId, _testId, body) => {
      request = body;
    },
  };
  const endedAt = new Date('2026-07-15T15:05:45.666Z');
  await reporter.finishTest(
    1,
    2,
    {
      status: 'failed',
      startTime: new Date('2026-07-15T15:04:09.586Z'),
      error: {
        message: 'Expected pasted',
        stack: 'Error: Expected pasted\n    at locator-input.spec.js:247:43',
      },
    },
    endedAt,
  );
  assert.equal(request.endedAt, endedAt);
  assert.equal(request.reason.match(/Expected pasted/g).length, 1);
});

test('uploads ordinary logs in bounded batches', async () => {
  const reporter = new Reporter();
  const batches = [];
  reporter.apiClient = {
    sendLogs: async (_launchId, logs) => batches.push(logs),
  };
  reporter.errors = new Map();
  const logs = Array.from({ length: 205 }, (_, index) => ({
    level: 'INFO',
    timestamp: index,
    message: `log ${index}`,
    type: 'log',
    testId: 1,
  }));
  await reporter.attachTestLogs(1, logs);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );
});

test('propagates log upload failures to attempt synchronization', async () => {
  const reporter = new Reporter();
  reporter.apiClient = {
    sendLogs: async () => {
      throw new Error('log upload failed');
    },
  };
  reporter.errors = new Map();
  await assert.rejects(
    reporter.attachTestLogs(1, [
      { level: 'INFO', timestamp: 1, message: 'log', type: 'log', testId: 1 },
    ]),
    /log upload failed/,
  );
  assert.equal(reporter.errors.get('attachTestLogs'), 1);
});

test('finalizes the remote test even when an auxiliary upload fails', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: {
      ignorePlaywrightSteps: false,
      format: 'structured',
      includeDuration: true,
      includeLocation: true,
      maxSourceLines: 3,
      maxMessageLength: 8000,
    },
  };
  reporter.zbrLaunchId = 1;
  reporter.resultStats = {};
  reporter.pwTestIdToZbrStartedTry = new Map([['test-id', 0]]);
  reporter.pwTestIdToZbrTestId = new Map([['test-id', 2]]);
  reporter.pwTestIdToCapabilities = new Map();
  reporter.attachTestLabels = async () => {
    throw new Error('label upload failed');
  };
  let finalized = false;
  reporter.finishTest = async () => {
    finalized = true;
  };
  const project = {
    title: 'iphone',
    type: 'project',
    parent: { title: '', type: 'root' },
    project: () => ({ name: 'iphone' }),
  };
  const file = {
    title: 'specs/sample.spec.js',
    type: 'file',
    parent: project,
    project: project.project,
  };
  const pwTest = {
    id: 'test-id',
    _projectId: 'iphone',
    title: 'fails upload',
    parent: file,
    expectedStatus: 'passed',
    retries: 0,
  };
  const result = {
    retry: 0,
    status: 'passed',
    duration: 5,
    startTime: new Date(),
    steps: [],
    attachments: [],
  };
  const state = {
    attempt: 0,
    startedAt: result.startTime,
    endedAt: new Date(),
    actions: [],
    artifactReferences: [],
    customArtifacts: [],
    customVideos: [],
    labels: [],
    testCases: [],
    shouldBeReverted: false,
    sentLogKeys: new Set(),
    flushing: false,
  };
  const printed = [];
  const restoreLog = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    await assert.rejects(reporter.reportTestEnd(pwTest, result, state), /label upload failed/);
  } finally {
    console.log = restoreLog;
  }
  assert.equal(finalized, true);
  // The result must reach the console even though every upload after it failed.
  assert.ok(printed.some((line) => line.includes('[PASS]') && line.includes('fails upload')));
});

test('records skipped attempt finish logs at INFO', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: {
      ignorePlaywrightSteps: false,
      format: 'structured',
      includeDuration: true,
      includeLocation: true,
      maxSourceLines: 3,
      maxMessageLength: 8000,
    },
  };
  reporter.zbrLaunchId = 1;
  reporter.resultStats = {};
  reporter.pwTestIdToZbrStartedTry = new Map([['skip-id', 0]]);
  reporter.pwTestIdToZbrTestId = new Map([['skip-id', 2]]);
  reporter.pwTestIdToCapabilities = new Map();
  reporter.attachTestLabels = async () => {};
  let uploadedLogs = [];
  reporter.attachTestLogs = async (_launchId, logs) => {
    uploadedLogs = logs;
  };
  reporter.attachTestMaintainer = async () => {};
  reporter.attachTestCases = async () => {};
  reporter.attachTestFiles = async () => {};
  reporter.attachTestArtifactReferences = async () => {};
  reporter.attachTestScreenshots = async () => {};
  reporter.finishTest = async () => {};
  const project = {
    title: 'iphone',
    type: 'project',
    parent: { title: '', type: 'root' },
    project: () => ({ name: 'iphone' }),
  };
  const file = {
    title: 'specs/sample.spec.js',
    type: 'file',
    parent: project,
    project: project.project,
  };
  const pwTest = {
    id: 'skip-id',
    _projectId: 'iphone',
    title: 'skips on purpose',
    parent: file,
    expectedStatus: 'skipped',
    retries: 0,
  };
  const result = {
    retry: 0,
    status: 'skipped',
    duration: 3_500,
    startTime: new Date(),
    steps: [],
    attachments: [],
  };
  const state = {
    attempt: 0,
    startedAt: result.startTime,
    endedAt: new Date(),
    actions: [],
    artifactReferences: [],
    customArtifacts: [],
    customVideos: [],
    labels: [],
    testCases: [],
    shouldBeReverted: false,
    sentLogKeys: new Set(),
    flushing: false,
  };
  await reporter.reportTestEnd(pwTest, result, state);
  const finish = uploadedLogs.find((entry) => String(entry.message).includes('finished: skipped'));
  assert.equal(finish.level, 'INFO');
});

test('registers a test session with the provider session id and uploads no artifacts', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: {
      ignorePlaywrightSteps: false,
      format: 'structured',
      includeDuration: true,
      includeLocation: true,
      maxSourceLines: 3,
      maxMessageLength: 8000,
    },
  };
  reporter.zbrLaunchId = 1;
  reporter.resultStats = {};
  reporter.activeTestSessionIds = new Set();
  reporter.pwTestIdToZbrStartedTry = new Map([['test-id', 0]]);
  reporter.pwTestIdToZbrTestId = new Map([['test-id', 2]]);
  reporter.pwTestIdToCapabilities = new Map();

  let sessionRequest;
  let sessionFinished = false;
  let attachedFiles;
  reporter.apiClient = {
    startTestSession: async (_launchId, request) => {
      sessionRequest = request;
      return 55;
    },
    finishTestSession: async () => {
      sessionFinished = true;
    },
  };
  reporter.attachTestLabels = async () => {};
  reporter.attachTestLogs = async () => {};
  reporter.attachTestMaintainer = async () => {};
  reporter.attachTestCases = async () => {};
  reporter.attachTestFiles = async (_launchId, _testId, files) => {
    attachedFiles = files;
  };
  reporter.attachTestArtifactReferences = async () => {};
  reporter.attachTestScreenshots = async () => {};
  let finalized = false;
  reporter.finishTest = async () => {
    finalized = true;
  };

  assert.equal(typeof reporter.presignArtifactUrl, 'undefined');
  assert.equal(typeof reporter.downloadLogFiles, 'undefined');
  assert.equal(typeof reporter.resolveArtifactUrlsBySessionId, 'undefined');

  const project = {
    title: 'iphone',
    type: 'project',
    parent: { title: '', type: 'root' },
    project: () => ({ name: 'iphone' }),
  };
  const file = {
    title: 'specs/sample.spec.js',
    type: 'file',
    parent: project,
    project: project.project,
  };
  const pwTest = {
    id: 'test-id',
    _projectId: 'iphone',
    title: 'session only',
    parent: file,
    expectedStatus: 'passed',
    retries: 0,
  };
  const result = {
    retry: 0,
    status: 'passed',
    duration: 5,
    startTime: new Date(),
    steps: [],
    attachments: [],
  };
  const state = {
    attempt: 0,
    startedAt: result.startTime,
    endedAt: new Date(),
    actions: [],
    artifactReferences: [],
    customArtifacts: [],
    customVideos: [],
    labels: [],
    providerSessionId: 'bridge-uuid-123',
    testCases: [],
    shouldBeReverted: false,
    sentLogKeys: new Set(),
    flushing: false,
    videoCapabilities: {
      browserName: 'Safari',
      platformName: 'iOS',
      platformVersion: '18.7',
      deviceName: 'iPhone XR',
    },
  };

  const previousOrchestrator = process.env.PWM_ORCHESTRATOR;
  process.env.PWM_ORCHESTRATOR = 'ws://orchestrator.example:7777';
  try {
    await reporter.reportTestEnd(pwTest, result, state);
  } finally {
    if (previousOrchestrator === undefined) {
      delete process.env.PWM_ORCHESTRATOR;
    } else {
      process.env.PWM_ORCHESTRATOR = previousOrchestrator;
    }
  }

  assert.equal(sessionRequest.sessionId, 'bridge-uuid-123');
  assert.equal(sessionRequest.desiredCapabilities.browserName, 'Safari');
  assert.equal(sessionRequest.desiredCapabilities.platformName, 'iOS');
  assert.equal(sessionRequest.desiredCapabilities.platformVersion, '18.7');
  assert.equal(sessionRequest.desiredCapabilities.deviceName, 'iPhone XR');
  assert.equal(sessionRequest.desiredCapabilities.browserVersion, undefined);
  assert.equal(sessionRequest.desiredCapabilities['zebrunner:provider'], 'ZEBRUNNER_DEVICE_FARM');
  assert.equal(sessionFinished, true);
  assert.deepEqual(attachedFiles, []);
  assert.equal(finalized, true);
});

test('starts the Zebrunner session when attachSessionCapabilities arrives', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = { enabled: true, logs: structuredOptions };
  reporter.zbrLaunchId = 1;
  reporter.errors = new Map();
  reporter.activeTestSessionIds = new Set();
  reporter.pwTestIdToZbrStartedTry = new Map([['live-session', 0]]);
  reporter.pwTestIdToZbrTestId = new Map([['live-session', 9]]);
  reporter.pwTestIdToCapabilities = new Map();

  let sessionStarts = 0;
  reporter.startTestSessionAndGetId = async (_launchId, zbrTestId, _pwTest, _startedAt, providerSessionId) => {
    sessionStarts += 1;
    assert.equal(zbrTestId, 9);
    assert.equal(providerSessionId, 'esg-session-1');
    return 44;
  };

  const project = {
    title: 'chrome-esg',
    type: 'project',
    parent: { title: '', type: 'root' },
    project: () => ({ name: 'chrome-esg' }),
  };
  const pwTest = {
    id: 'live-session',
    title: 'opens example.com',
    parent: { title: 'spec.ts', type: 'file', parent: project, project: project.project },
    expectedStatus: 'passed',
    retries: 0,
  };
  const result = {
    retry: 0,
    startTime: new Date(),
    stdout: [],
    stderr: [],
    steps: [],
    attachments: [],
  };

  reporter.handleStdOutChunk(
    JSON.stringify({
      eventType: EVENT_NAMES.ATTACH_TEST_SESSION_CAPABILITIES,
      payload: {
        sessionId: 'esg-session-1',
        capabilities: { browserName: 'chrome', platformName: 'linux', 'zebrunner:provider': 'ZEBRUNNER' },
      },
    }),
    pwTest,
    result,
  );

  const state = reporter.pwTestResultToState.get(result);
  await state.sessionStartPromise;
  assert.equal(state.zbrSessionId, 44);
  assert.equal(sessionStarts, 1);
  assert.equal(state.providerSessionId, 'esg-session-1');
  assert.equal(
    state.labels.find((label) => label.key === 'first-session-id' || label.key === 'sessionId'),
    undefined,
  );

  reporter.handleStdOutChunk(
    JSON.stringify({
      eventType: EVENT_NAMES.ATTACH_TEST_SESSION_CAPABILITIES,
      payload: {
        sessionId: 'esg-session-1',
        capabilities: { browserName: 'chrome', platformName: 'linux' },
      },
    }),
    pwTest,
    result,
  );
  await state.sessionStartPromise;
  assert.equal(sessionStarts, 1);
});

const makeFlushingReporter = (batches) => {
  const reporter = new Reporter();
  reporter.zbrLaunchId = 7;
  reporter.errors = new Map();
  reporter.reportingConfig = {
    enabled: true,
    logs: {
      ...structuredOptions,
      includeDuration: false,
      includeLocation: false,
      maxSourceLines: 0,
      flushIntervalMs: 1000,
    },
  };
  reporter.apiClient = {
    sendLogs: async (launchId, logs) => {
      batches.push(logs.map((entry) => entry.message));
    },
  };
  return reporter;
};

test('streams completed steps mid-test and does not resend them at test end', async () => {
  const batches = [];
  const reporter = makeFlushingReporter(batches);
  const pwTest = { id: 'flush-test', title: 'streams logs' };
  const result = { retry: 0, startTime: new Date(1000), stdout: [], stderr: [], steps: [], attachments: [] };
  const state = reporter.getPwTestAttemptState(pwTest, result);

  result.steps.push({ title: 'click(#a)', category: 'pw:api', startTime: new Date(1100), duration: 5 });
  result.steps.push({ title: 'fill(#b)', category: 'pw:api', startTime: new Date(1200), duration: -1 });

  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches, [['Attempt 1 started', 'click(#a)']]);

  result.steps[1].duration = 7;
  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches[1], ['fill(#b)']);

  const finalEntries = reporter.selectUnsentLogs(state, [
    reporter.attemptStartedLog(state, 77),
    ...getTestLogs(result.steps, 77, reporter.buildLogOptions(false), state.actions),
  ]);
  assert.deepEqual(finalEntries, []);
});

test('live flush holds newer logs behind an unfinished older step', async () => {
  const batches = [];
  const reporter = makeFlushingReporter(batches);
  const pwTest = { id: 'flush-order', title: 'keeps chronological order' };
  const result = { retry: 0, startTime: new Date(1_000), stdout: [], stderr: [], steps: [], attachments: [] };
  const state = reporter.getPwTestAttemptState(pwTest, result);
  result.steps.push({ title: 'older pending', category: 'pw:api', startTime: new Date(1_100), duration: -1 });
  result.steps.push({ title: 'newer complete', category: 'pw:api', startTime: new Date(1_200), duration: 5 });

  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches, [['Attempt 1 started']]);

  result.steps[0].duration = 10;
  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches[1], ['older pending', 'newer complete']);
});

test('live flush holds completed steps behind an unfinished older action', async () => {
  const batches = [];
  const reporter = makeFlushingReporter(batches);
  const pwTest = { id: 'flush-action-order', title: 'keeps action order' };
  const result = { retry: 0, startTime: new Date(1_000), stdout: [], stderr: [], steps: [], attachments: [] };
  const state = reporter.getPwTestAttemptState(pwTest, result);
  state.actions.push({
    id: 'pending-action',
    kind: 'playwright',
    method: 'probe.waitUntilReady',
    startedAt: 1_100,
    status: 'started',
  });
  result.steps.push({ title: 'newer complete', category: 'pw:api', startTime: new Date(1_200), duration: 5 });

  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches, [['Attempt 1 started']]);

  state.actions[0] = { ...state.actions[0], endedAt: 1_250, status: 'passed' };
  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches[1], ['probe.waitUntilReady', 'newer complete']);
});

test('retries a failed flush at test end instead of dropping its entries', async () => {
  const batches = [];
  const reporter = makeFlushingReporter(batches);
  reporter.apiClient = {
    sendLogs: async () => {
      throw new Error('flush upload failed');
    },
  };
  const pwTest = { id: 'flush-retry', title: 'retries' };
  const result = { retry: 0, startTime: new Date(1000), stdout: [], stderr: [], steps: [], attachments: [] };
  const state = reporter.getPwTestAttemptState(pwTest, result);
  result.steps.push({ title: 'click(#a)', category: 'pw:api', startTime: new Date(1100), duration: 5 });

  await reporter.flushTestLogs(result, state, 77);
  assert.equal(reporter.errors.get('flushTestLogs'), 1);
  assert.equal(state.sentLogKeys.size, 0);

  const finalEntries = reporter.selectUnsentLogs(state, [
    reporter.attemptStartedLog(state, 77),
    ...getTestLogs(result.steps, 77, reporter.buildLogOptions(false), state.actions),
  ]);
  assert.deepEqual(
    finalEntries.map((entry) => entry.message),
    ['Attempt 1 started', 'click(#a)'],
  );
});

test('keeps identical log entries produced by a single render', () => {
  const reporter = makeFlushingReporter([]);
  const pwTest = { id: 'flush-repeats', title: 'repeats' };
  const result = { retry: 0, startTime: new Date(1000), stdout: [], stderr: [], steps: [], attachments: [] };
  const state = reporter.getPwTestAttemptState(pwTest, result);
  const repeated = { timestamp: 1100, level: 'INFO', message: 'click(#a)', testId: 77, type: 'log' };

  assert.equal(reporter.selectUnsentLogs(state, [{ ...repeated }, { ...repeated }]).length, 2);
  assert.equal(reporter.selectUnsentLogs(state, [{ ...repeated }, { ...repeated }]).length, 0);
});

test('withholds unfinished structured actions until they complete', async () => {
  const batches = [];
  const reporter = makeFlushingReporter(batches);
  const pwTest = { id: 'flush-actions', title: 'streams actions' };
  const result = { retry: 0, startTime: new Date(1000), stdout: [], stderr: [], steps: [], attachments: [] };
  const state = reporter.getPwTestAttemptState(pwTest, result);
  const action = {
    id: 'action-1',
    kind: 'bridge',
    method: 'page.bridge.getSessionId',
    startedAt: 1100,
    status: 'started',
  };
  state.actions.push(action);

  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches, [['Attempt 1 started']]);

  state.actions[0] = { ...action, endedAt: 1150, status: 'passed' };
  await reporter.flushTestLogs(result, state, 77);
  assert.deepEqual(batches[1], ['page.bridge.getSessionId']);
});

test('marks the latest running structured action as failed when the test times out', () => {
  const reporter = new Reporter();
  const result = {
    status: 'timedOut',
    error: { message: 'Test timeout of 10000ms exceeded.' },
    steps: [],
  };
  const state = {
    actions: [
      {
        id: 'older-complete',
        kind: 'playwright',
        method: 'page.goto',
        startedAt: 1_000,
        endedAt: 1_100,
        status: 'passed',
      },
      {
        id: 'active-action',
        kind: 'playwright',
        method: 'probe.waitUntilReady',
        startedAt: 2_000,
        status: 'started',
      },
    ],
  };

  reporter.markTimedOutOperationFailed(result, state, new Date(12_000));

  assert.equal(state.actions[0].status, 'passed');
  assert.deepEqual(state.actions[1], {
    id: 'active-action',
    kind: 'playwright',
    method: 'probe.waitUntilReady',
    startedAt: 2_000,
    endedAt: 12_000,
    status: 'failed',
    error: 'Test timed out while executing this action. Test timeout of 10000ms exceeded.',
  });
});

test('marks the latest unfinished Playwright step as failed when no structured action is running', () => {
  const reporter = new Reporter();
  const olderStep = {
    title: 'older completed action',
    category: 'pw:api',
    startTime: new Date(1_000),
    duration: 25,
    steps: [],
  };
  const activeStep = {
    title: 'click locator("#slow")',
    category: 'pw:api',
    startTime: new Date(2_000),
    duration: -1,
    steps: [],
  };
  const result = {
    status: 'timedOut',
    errors: [{ message: 'Test timeout of 5000ms exceeded.' }],
    steps: [olderStep, activeStep],
  };

  reporter.markTimedOutOperationFailed(result, { actions: [] }, new Date(7_000));

  assert.equal(olderStep.error, undefined);
  assert.equal(activeStep.duration, 5_000);
  assert.deepEqual(activeStep.error, {
    message: 'Test timed out while executing this action. Test timeout of 5000ms exceeded.',
  });
});

test('does not blame the last completed action when a timeout has no running operation', () => {
  const reporter = new Reporter();
  const completedStep = {
    title: 'completed action',
    category: 'pw:api',
    startTime: new Date(1_000),
    duration: 25,
    steps: [],
  };
  const result = {
    status: 'timedOut',
    error: { message: 'Test timeout of 5000ms exceeded.' },
    steps: [completedStep],
  };
  const state = {
    actions: [{
      id: 'complete',
      kind: 'playwright',
      method: 'page.goto',
      startedAt: 1_000,
      endedAt: 1_025,
      status: 'passed',
    }],
  };

  reporter.markTimedOutOperationFailed(result, state, new Date(6_000));

  assert.equal(completedStep.error, undefined);
  assert.equal(state.actions[0].status, 'passed');
});
