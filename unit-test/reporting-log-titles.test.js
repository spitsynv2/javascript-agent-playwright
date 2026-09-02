const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getTestLogs } = require('../build/javascript-agent-playwright/helpers');

const structuredOptions = {
  ignorePlaywrightSteps: false,
  includeHooks: false,
  includeFixtures: false,
  includeBridgeActions: true,
  format: 'structured',
  includeDuration: false,
  includeLocation: false,
  maxSourceLines: 4,
  maxMessageLength: 8000,
};

const firstLine = (message) => String(message).split('\n')[0];
const sourceLine = (message) =>
  String(message)
    .split('\n')
    .find((line) => line.trim().startsWith('source:'))
    ?.replace(/^\s*source:\s*/, '');

const withSource = (lines, run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-log-titles-'));
  const sourcePath = path.join(dir, 'sample.spec.ts');
  fs.writeFileSync(sourcePath, `${lines.join('\n')}\n`);
  try {
    return run(sourcePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('rewrites Navigate to a path when page.goto uses a string constant', () => {
  withSource(
    [
      "const BASIC_URL = 'https://the-internet.herokuapp.com/basic_auth';",
      "await page.goto(BASIC_URL, { waitUntil: 'domcontentloaded' });",
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Navigate to "/basic_auth"',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 2, column: 16 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      assert.equal(
        firstLine(logs[0].message),
        'Navigate to "https://the-internet.herokuapp.com/basic_auth"',
      );
    },
  );
});

test('rewrites Navigate to a path when the URL constant is a template of another constant', () => {
  withSource(
    [
      "const BASE = 'https://the-internet.herokuapp.com';",
      'const BASIC_URL = `${BASE}/basic_auth`;',
      "await page.goto(BASIC_URL, { waitUntil: 'domcontentloaded' });",
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Navigate to "/basic_auth"',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 3, column: 16 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      assert.equal(
        firstLine(logs[0].message),
        'Navigate to "https://the-internet.herokuapp.com/basic_auth"',
      );
    },
  );
});

test('rewrites a lossy Navigate to "/" title from the page.goto source URL', () => {
  withSource(
    ["await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });"],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Navigate to "/"',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 1, column: 16 },
            steps: [],
          },
        ],
        1,
        { ...structuredOptions, includeLocation: true },
      );
      assert.equal(firstLine(logs[0].message), 'Navigate to "https://example.com/"');
      assert.equal(
        sourceLine(logs[0].message),
        "await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });",
      );
      assert.match(logs[0].message, /at: /);
      assert.doesNotMatch(firstLine(logs[0].message), /Navigate to "\/"/);
    },
  );
});

test('keeps Navigate to "/" when page.goto uses an identifier argument', () => {
  withSource(
    [
      'await page.goto(',
      '  targetUrl,',
      "  { waitUntil: 'domcontentloaded' },",
      ');',
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Navigate to "/"',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 1, column: 1 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      assert.equal(firstLine(logs[0].message), 'Navigate to "/"');
    },
  );
});

test('does not leak the next statement after a trailing source comment', () => {
  withSource(
    [
      "await page.goto('https://playwright.dev/', { waitUntil: 'domcontentloaded' }); // security-scan: allow -- public Playwright documentation site",
      'const err = await rejection(',
      "  expect(page.locator('h1').first()).toHaveText('this-text-will-never-match', { timeout: FAIL_TIMEOUT })",
      ');',
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Navigate to "/"',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 1, column: 1 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      const source = sourceLine(logs[0].message);
      assert.equal(firstLine(logs[0].message), 'Navigate to "https://playwright.dev/"');
      assert.equal(
        source,
        "await page.goto('https://playwright.dev/', { waitUntil: 'domcontentloaded' });",
      );
      assert.doesNotMatch(source, /const err/);
      assert.doesNotMatch(firstLine(logs[0].message), /security-scan/);
    },
  );
});

test('keeps constructor arguments on toBeInstanceOf titles', () => {
  withSource(['expect(err, `should reject`).toBeInstanceOf(Error);'], (sourcePath) => {
    const logs = getTestLogs(
      [
        {
          title: 'Expect "toBeInstanceOf"',
          category: 'expect',
          startTime: new Date(1),
          duration: 1,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
      ],
      1,
      { ...structuredOptions, format: 'playwright-title' },
    );
    assert.equal(logs[0].message, 'Expect err to be instance of Error');
  });
});

test('rewrites Expect "toBe" when the matcher is on the next line', () => {
  withSource(
    [
      'await expect.poll(() => page.evaluate(() => window.__dbl.double), { timeout: 10_000 })',
      '  .toBe(1);',
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Expect "toBe"',
            category: 'expect',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 1, column: 7 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      assert.equal(firstLine(logs[0].message), 'Expect to be 1');
      assert.match(sourceLine(logs[0].message), /\.toBe\(1\)/);
      assert.doesNotMatch(firstLine(logs[0].message), /Expect "toBe"/);
    },
  );
});

test('humanizes Expect "toBe" when source has no matcher call', () => {
  withSource(['await expect.poll(() => value);'], (sourcePath) => {
    const logs = getTestLogs(
      [
        {
          title: 'Expect "toBe"',
          category: 'expect',
          startTime: new Date(1),
          duration: 1,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
      ],
      1,
      { ...structuredOptions, format: 'playwright-title' },
    );
    assert.equal(logs[0].message, 'Expect to be');
  });
});

test('rewrites GET and POST paths from request URL constants', () => {
  withSource(
    [
      "const TEXT_TARGET = 'https://example.com/';",
      "const JSON_API = 'https://jsonplaceholder.typicode.com';",
      'const res = await request.get(TEXT_TARGET);',
      'const created = await request.post(`${JSON_API}/users`, { data: { name: "Ada" } });',
      "const relative = await ctx.get('/users/2');",
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'GET "/"',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 3, column: 28 },
            steps: [],
          },
          {
            title: 'POST "/users"',
            category: 'pw:api',
            startTime: new Date(2),
            duration: 1,
            location: { file: sourcePath, line: 4, column: 32 },
            steps: [],
          },
          {
            title: 'GET "/users/2"',
            category: 'pw:api',
            startTime: new Date(3),
            duration: 1,
            location: { file: sourcePath, line: 5, column: 33 },
            steps: [],
          },
        ],
        1,
        { ...structuredOptions, format: 'playwright-title' },
      );
      assert.deepEqual(
        logs.map((entry) => entry.message),
        ['GET "https://example.com/"', 'POST "https://jsonplaceholder.typicode.com/users"', 'GET "/users/2"'],
      );
    },
  );
});

test('rewrites bare Android Wait and Tap titles from the selector', () => {
  withSource(
    [
      "const LABEL = 'Allow this time';",
      'await device.wait({ text: LABEL }, { timeout });',
      'await device.tap({ text: LABEL });',
      'await device.wait({ text }, { timeout });',
      'await page.waitForTimeout(1500);',
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Wait',
            category: 'pw:api',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 2, column: 16 },
            steps: [],
          },
          {
            title: 'Tap',
            category: 'pw:api',
            startTime: new Date(2),
            duration: 1,
            location: { file: sourcePath, line: 3, column: 16 },
            steps: [],
          },
          {
            title: 'Wait',
            category: 'pw:api',
            startTime: new Date(3),
            duration: 1,
            location: { file: sourcePath, line: 4, column: 16 },
            steps: [],
          },
          {
            title: 'Wait for timeout',
            category: 'pw:api',
            startTime: new Date(4),
            duration: 1,
            location: { file: sourcePath, line: 5, column: 16 },
            steps: [],
          },
        ],
        1,
        { ...structuredOptions, format: 'playwright-title' },
      );
      assert.deepEqual(
        logs.map((entry) => entry.message),
        ['Wait for "Allow this time"', 'Tap "Allow this time"', 'Wait for text', 'Wait for timeout'],
      );
    },
  );
});

test('strips leftover wrapper closers and extra parens from expect titles', () => {
  withSource(
    [
      'const err = await rejection(',
      "  expect(page.locator('#ghost-' + Date.now())).toBeVisible({ timeout: FAIL_TIMEOUT })",
      ');',
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: "Expect \"toBeVisible\" locator('#ghost-1')",
            category: 'expect',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 2, column: 1 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      assert.equal(firstLine(logs[0].message), "Expect locator('#ghost-1') to be visible { timeout: FAIL_TIMEOUT }");
      assert.equal(
        sourceLine(logs[0].message),
        "expect(page.locator('#ghost-' + Date.now())).toBeVisible({ timeout: FAIL_TIMEOUT })",
      );
      assert.doesNotMatch(firstLine(logs[0].message), /FAIL_TIMEOUT \)/);
      assert.doesNotMatch(sourceLine(logs[0].message), /\);$/);
    },
  );
});

test('omits identifier arguments that would echo the matcher name', () => {
  withSource(
    [
      'await expect(page, `iter#${i}`).toHaveTitle(title);',
      'expect(actual, `${label}: equals`).toBe(expected);',
      "await expect(page).toHaveTitle(p.title, { timeout: 15_000 });",
      "await expect(page.locator('#result')).toHaveText('Clicked!');",
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Expect "toHaveTitle"',
            category: 'expect',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 1, column: 1 },
            steps: [],
          },
          {
            title: 'Expect "toBe"',
            category: 'expect',
            startTime: new Date(2),
            duration: 1,
            location: { file: sourcePath, line: 2, column: 1 },
            steps: [],
          },
          {
            title: 'Expect "toHaveTitle"',
            category: 'expect',
            startTime: new Date(3),
            duration: 1,
            location: { file: sourcePath, line: 3, column: 1 },
            steps: [],
          },
          {
            title: 'Expect "toHaveText" locator("#result")',
            category: 'expect',
            startTime: new Date(4),
            duration: 1,
            location: { file: sourcePath, line: 4, column: 1 },
            steps: [],
          },
        ],
        1,
        { ...structuredOptions, format: 'playwright-title' },
      );
      assert.deepEqual(
        logs.map((entry) => entry.message),
        [
          'Expect page to have title',
          'Expect actual to be',
          'Expect page to have title { timeout: 15_000 }',
          "Expect locator(\"#result\") to have text 'Clicked!'",
        ],
      );
    },
  );
});

test('expands continuation snippets so toPass does not start mid-statement', () => {
  withSource(
    [
      'await expect(async () => {',
      '  expect(attempts, `needs a few attempts`).toBeGreaterThanOrEqual(3);',
      '}).toPass({ timeout: 5000, intervals: [100, 100, 100] });',
    ],
    (sourcePath) => {
      const logs = getTestLogs(
        [
          {
            title: 'Expect "toPass"',
            category: 'expect',
            startTime: new Date(1),
            duration: 1,
            location: { file: sourcePath, line: 3, column: 1 },
            steps: [],
          },
        ],
        1,
        structuredOptions,
      );
      assert.equal(firstLine(logs[0].message), 'Expect to pass { timeout: 5000, intervals: [100, 100, 100] }');
      assert.match(sourceLine(logs[0].message), /^await expect\(async \(\) => \{/);
      assert.doesNotMatch(sourceLine(logs[0].message), /^}\)\.toPass/);
    },
  );
});

test('strips Playwright schema placeholders from clock titles', () => {
  withSource(['await page.clock.install();'], (sourcePath) => {
    const logs = getTestLogs(
      [
        {
          title: 'Install clock "{timeNumber|timeString}"',
          category: 'pw:api',
          startTime: new Date(1),
          duration: 1,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
      ],
      1,
      { ...structuredOptions, format: 'playwright-title' },
    );
    assert.equal(logs[0].message, 'Install clock');
  });
});

test('suppresses Close page when it shares a source line with a bridge action', () => {
  withSource(['await page.bridge.clearSafariHistory();'], (sourcePath) => {
    const logs = getTestLogs(
      [
        {
          title: 'Close page',
          category: 'pw:api',
          startTime: new Date(1_000),
          duration: 10,
          location: { file: sourcePath, line: 1, column: 7 },
          steps: [],
        },
      ],
      1,
      structuredOptions,
      [
        {
          id: 'bridge-1',
          kind: 'bridge',
          method: 'page.bridge.clearSafariHistory',
          params: {},
          startedAt: 1_000,
          endedAt: 1_010,
          status: 'passed',
          source: { file: sourcePath, line: 1, column: 25 },
        },
      ],
    );
    assert.deepEqual(
      logs.map((entry) => firstLine(entry.message)),
      ['page.bridge.clearSafariHistory'],
    );
  });
});
