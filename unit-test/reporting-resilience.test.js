const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isTransientNetworkError,
  withNetworkRetry,
  formatRequestError,
} = require('../build/javascript-agent-playwright/helpers');
const { ZebrunnerApiClient } = require('../build/javascript-agent-playwright/ZebrunnerApiClient');
const { ReportingConfig } = require('../build/javascript-agent-playwright/ReportingConfig');
const Reporter = require('../build/javascript-agent-playwright/ZebrunnerReporter').default;

const withEnv = async (key, value, fn) => {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
};

test('classifies transient network codes and 5xx responses, but not 4xx', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED']) {
    assert.equal(isTransientNetworkError({ code }), true, code);
  }
  for (const status of [502, 503, 504]) {
    assert.equal(isTransientNetworkError({ response: { status } }), true, String(status));
  }
  for (const status of [400, 401, 404]) {
    assert.equal(isTransientNetworkError({ response: { status } }), false, String(status));
  }
  assert.equal(isTransientNetworkError(new Error('boom')), false);
  assert.equal(isTransientNetworkError(undefined), false);
});

test('retries a transient failure with backoff and then resolves', async () => {
  let calls = 0;
  const result = await withNetworkRetry(
    async () => {
      calls += 1;
      if (calls <= 2) {
        throw { code: 'ECONNRESET' };
      }
      return 'ok';
    },
    { retries: 2, delayMs: 0 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('rethrows after exhausting retries on a persistent transient error', async () => {
  let calls = 0;
  await assert.rejects(
    withNetworkRetry(
      async () => {
        calls += 1;
        throw { code: 'ENOTFOUND' };
      },
      { retries: 2, delayMs: 0 },
    ),
    (error) => error.code === 'ENOTFOUND',
  );
  assert.equal(calls, 3);
});

test('does not retry a non-transient error', async () => {
  let calls = 0;
  await assert.rejects(
    withNetworkRetry(
      async () => {
        calls += 1;
        throw { response: { status: 400 } };
      },
      { retries: 3, delayMs: 0 },
    ),
    (error) => error.response.status === 400,
  );
  assert.equal(calls, 1);
});

test('retries a 5xx response and then resolves', async () => {
  let calls = 0;
  const result = await withNetworkRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw { response: { status: 503 } };
      }
      return 'recovered';
    },
    { retries: 2, delayMs: 0 },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

test('formats a connection-level error from config and code without undefined', () => {
  const message = formatRequestError({
    config: { method: 'put', baseURL: 'https://h', url: '/x' },
    code: 'ENOTFOUND',
    stack: 'Error: getaddrinfo ENOTFOUND h',
  });
  assert.match(message, /Could not send request PUT https:\/\/h\/x/);
  assert.match(message, /\(ENOTFOUND\)/);
  assert.doesNotMatch(message, /undefined/);
  assert.match(message, /getaddrinfo ENOTFOUND h/);
});

test('includes the raw response body when present', () => {
  const message = formatRequestError({
    config: { method: 'post', baseURL: 'https://h', url: '/logs' },
    response: { data: { message: 'bad request' } },
  });
  assert.match(message, /Raw response/);
  assert.match(message, /bad request/);
});

test('ZebrunnerApiClient retries a transient request before it surfaces', async () => {
  await withEnv('ZBR_NET_RETRY_DELAY_MS', '0', async () => {
    const client = new ZebrunnerApiClient(
      new ReportingConfig({ enabled: true, server: { hostname: 'https://h', accessToken: 't' } }),
    );
    let calls = 0;
    client.axiosInstance = {
      put: async () => {
        calls += 1;
        if (calls === 1) {
          throw { code: 'ETIMEDOUT' };
        }
        return { data: {} };
      },
    };

    const response = await client.finishTest(1, 2, { result: 'PASSED', endedAt: new Date() });
    assert.deepEqual(response, { data: {} });
    assert.equal(calls, 2);
  });
});

test('onTestEnd contains a reporting failure instead of aborting the run', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = { enabled: true };
  reporter.pwTestIdToZbrFinishedTry = new Map();
  reporter.reportTestEnd = async () => {
    throw { code: 'ENOTFOUND' };
  };
  const pwTest = { id: 'test-id', title: 'unreachable host' };
  const result = { retry: 0, stdout: [], stderr: [], steps: [], attachments: [] };

  const printed = [];
  const restoreLog = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    await reporter.onTestEnd(pwTest, result);
  } finally {
    console.log = restoreLog;
  }

  assert.equal(reporter.errors.get('onTestEnd'), 1);
  assert.equal(reporter.pwTestResultToState.size, 0);
  assert.equal(reporter.pwTestIdToZbrFinishedTry.get('test-id'), 0);
});
