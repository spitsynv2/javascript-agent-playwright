const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { currentLaunch } = require('../build/javascript-agent-playwright/currentLaunch');
const { currentTest } = require('../build/javascript-agent-playwright/currentTest');
const { EVENT_NAMES } = require('../build/javascript-agent-playwright/constants/events');
const Reporter = require('../build/javascript-agent-playwright/ZebrunnerReporter').default;

const captureStdoutEvent = (callback) => {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    callback();
  } finally {
    process.stdout.write = originalWrite;
  }

  return { event: JSON.parse(chunks.join('')), serializedLength: chunks.join('').length };
};

const captureStdoutLines = (callback) => {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    callback();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('').trim().split(/\r?\n/).map((line) => JSON.parse(line));
};

test('spills screenshot buffers before emitting stdout events', () => {
  const screenshot = Buffer.alloc(1024 * 1024, 7);
  const { event, serializedLength } = captureStdoutEvent(() => currentTest.attachScreenshot(screenshot));

  try {
    assert.equal(typeof event.payload.pathOrBuffer, 'string');
    assert.equal(event.payload.deleteAfterUpload, true);
    assert.equal(Number.isFinite(event.payload.timestamp), true);
    assert.equal(serializedLength < 1024, true);
    assert.deepEqual(fs.readFileSync(event.payload.pathOrBuffer), screenshot);
  } finally {
    fs.rmSync(event.payload.pathOrBuffer, { force: true });
  }
});

test('timestamps custom logs when they are emitted', () => {
  const before = Date.now();
  const { event } = captureStdoutEvent(() => currentTest.log.info('ordered log'));
  assert.equal(event.eventType, EVENT_NAMES.ATTACH_TEST_LOG);
  assert.equal(event.payload.message, 'ordered log');
  assert.equal(event.payload.timestamp >= before, true);
  assert.equal(event.payload.timestamp <= Date.now(), true);
});

test('frames consecutive launch events as separate JSON lines', () => {
  const events = captureStdoutLines(() => {
    currentLaunch.attachLabel('suite', 'reporting');
    currentLaunch.attachArtifactReference('docs', 'https://example.com/reporting');
  });
  assert.deepEqual(
    events.map((event) => event.eventType),
    [EVENT_NAMES.ATTACH_LAUNCH_LABELS, EVENT_NAMES.ATTACH_LAUNCH_ARTIFACT_REFERENCES],
  );
});

test('frames consecutive validation errors as separate JSON lines', () => {
  const events = captureStdoutLines(() => {
    currentTest.log.info('');
    currentTest.attachLabel('', 'value');
  });
  assert.deepEqual(events.map((event) => event.eventType), [EVENT_NAMES.LOG_ERROR, EVENT_NAMES.LOG_ERROR]);
});

test('keeps file paths as lightweight stdout payloads', () => {
  const filePath = __filename;
  const { event } = captureStdoutEvent(() => currentTest.attachArtifact(filePath, 'artifact.js'));

  assert.equal(event.payload.pathOrBuffer, filePath);
  assert.equal(event.payload.deleteAfterUpload, false);
});

test('emits sanitized structured action events', () => {
  const params = { password: 'secret', blob: Buffer.alloc(1024 * 1024) };
  params.self = params;
  const { event, serializedLength } = captureStdoutEvent(() =>
    currentTest.attachAction({
      kind: 'playwright',
      method: 'page.goto',
      params,
      startedAt: 10,
      endedAt: 20,
      status: 'passed',
    }),
  );

  assert.equal(event.eventType, EVENT_NAMES.ATTACH_TEST_ACTION);
  assert.equal(event.payload.params.password, '[REDACTED]');
  assert.equal(event.payload.params.blob, '[Buffer 1048576 bytes]');
  assert.equal(event.payload.params.self, '[Circular]');
  assert.equal(serializedLength < 10_000, true);
});

for (const [name, attach] of [
  ['test artifact', () => currentTest.attachArtifact(Buffer.alloc(4096), 'artifact.bin')],
  ['test video', () => currentTest.attachVideo(Buffer.alloc(4096), 'video.mp4')],
]) {
  test(`spills ${name} buffers before emitting stdout events`, () => {
    const { event, serializedLength } = captureStdoutEvent(attach);

    try {
      assert.equal(typeof event.payload.pathOrBuffer, 'string');
      assert.equal(event.payload.deleteAfterUpload, true);
      assert.equal(serializedLength < 1024, true);
    } finally {
      fs.rmSync(event.payload.pathOrBuffer, { force: true });
    }
  });
}

test('spills launch artifact buffers and emits a stable fingerprint', () => {
  const artifact = Buffer.alloc(1024 * 1024, 11);
  const { event, serializedLength } = captureStdoutEvent(() => currentLaunch.attachArtifact(artifact, 'artifact.bin'));

  try {
    assert.equal(typeof event.payload.pathOrBuffer, 'string');
    assert.equal(event.payload.deleteAfterUpload, true);
    assert.match(event.payload.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(serializedLength < 1024, true);
    assert.deepEqual(fs.readFileSync(event.payload.pathOrBuffer), artifact);
  } finally {
    fs.rmSync(event.payload.pathOrBuffer, { force: true });
  }
});

test('removes spilled screenshots after upload', async () => {
  const screenshot = Buffer.alloc(4096, 9);
  const { event } = captureStdoutEvent(() => currentTest.attachScreenshot(screenshot));
  const reporter = new Reporter();
  let uploaded;
  reporter.apiClient = {
    uploadTestScreenshot: async (_launchId, _testId, file) => {
      uploaded = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
    },
  };

  await reporter.attachTestScreenshots(1, 2, [
    {
      timestamp: Date.now(),
      pathOrBuffer: event.payload.pathOrBuffer,
      deleteAfterUpload: event.payload.deleteAfterUpload,
    },
  ]);

  assert.deepEqual(uploaded, screenshot);
  assert.equal(fs.existsSync(event.payload.pathOrBuffer), false);
});

test('deletes each screenshot before the next upload', async () => {
  const first = Buffer.alloc(128, 1);
  const second = Buffer.alloc(128, 2);
  const firstPath = captureStdoutEvent(() => currentTest.attachScreenshot(first)).event.payload.pathOrBuffer;
  const secondPath = captureStdoutEvent(() => currentTest.attachScreenshot(second)).event.payload.pathOrBuffer;
  const reporter = new Reporter();
  const seen = [];
  reporter.apiClient = {
    uploadTestScreenshot: async () => {
      seen.push({
        firstExists: fs.existsSync(firstPath),
        secondExists: fs.existsSync(secondPath),
      });
    },
  };

  await reporter.attachTestScreenshots(1, 2, [
    { timestamp: 1, pathOrBuffer: firstPath, deleteAfterUpload: true },
    { timestamp: 2, pathOrBuffer: secondPath, deleteAfterUpload: true },
  ]);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].firstExists, true);
  assert.equal(seen[0].secondExists, true);
  assert.equal(seen[1].firstExists, false);
  assert.equal(seen[1].secondExists, true);
  assert.equal(fs.existsSync(firstPath), false);
  assert.equal(fs.existsSync(secondPath), false);
});

test('stores screenshot paths on steps without copying buffers', () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: { ignoreConsole: true, ignoreCustom: false, ignoreManualScreenshots: false },
  };
  reporter.pwTestIdToCapabilities = new Map();
  const pwTest = { id: 'path-only', title: 'path only' };
  const result = { retry: 0, startTime: new Date(), stdout: [], stderr: [], steps: [], attachments: [] };

  reporter.handleStdOutChunk(
    JSON.stringify({
      eventType: EVENT_NAMES.ATTACH_TEST_SCREENSHOT,
      payload: { pathOrBuffer: __filename, deleteAfterUpload: false, timestamp: 5432 },
    }),
    pwTest,
    result,
  );

  assert.equal(result.steps[0].screenshotPathOrBuffer, __filename);
  assert.equal(Buffer.isBuffer(result.steps[0].screenshotPathOrBuffer), false);
});

test('uploads a screenshot during the test and deletes the file', async () => {
  const screenshot = Buffer.alloc(4096, 5);
  const { event } = captureStdoutEvent(() => currentTest.attachScreenshot(screenshot));
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: { ignoreConsole: true, ignoreCustom: false, ignoreManualScreenshots: false },
  };
  reporter.zbrLaunchId = 1;
  reporter.pwTestIdToZbrTestId = new Map([['t', 2]]);
  reporter.pwTestIdToCapabilities = new Map();
  let uploaded;
  reporter.apiClient = {
    uploadTestScreenshot: async (_launchId, _testId, file) => {
      uploaded = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
    },
  };
  const pwTest = { id: 't', title: 'during' };
  const result = { retry: 0, startTime: new Date(), stdout: [], stderr: [], steps: [], attachments: [] };

  reporter.handleStdOutChunk(JSON.stringify(event), pwTest, result);
  const state = reporter.pwTestResultToState.get(result);
  await state.screenshotUpload;

  assert.deepEqual(uploaded, screenshot);
  assert.equal(fs.existsSync(event.payload.pathOrBuffer), false);
  assert.equal(result.steps[0].screenshotPathOrBuffer, undefined);
});

test('releases Playwright result payloads for a sole reporter', async () => {
  const reporter = new Reporter();
  reporter.releasePlaywrightResults = true;
  const state = {
    attempt: 0,
    startedAt: new Date(),
    actions: [],
    customArtifacts: [],
    customVideos: [],
    artifactReferences: [],
    logDownloadUrls: [],
    labels: [],
    testCases: [],
    shouldBeReverted: false,
    sentLogKeys: new Set(),
    flushing: false,
  };
  const result = {
    stdout: ['large stdout'],
    stderr: ['large stderr'],
    steps: [],
    attachments: [{ name: 'body', contentType: 'application/octet-stream', body: Buffer.alloc(4096) }],
  };
  reporter.pwTestResultToState.set(result, state);

  await reporter.releasePwTestBuffers(state, result);

  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.steps.length, 0);
  assert.equal(result.attachments[0].body, undefined);
  assert.equal(reporter.pwTestResultToState.size, 0);
});

test('keeps overlapping retry session state isolated and bounded', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = {
    enabled: true,
    logs: {
      ignoreConsole: true,
      ignoreCustom: false,
      ignoreManualScreenshots: false,
    },
  };
  reporter.pwTestIdToCapabilities = new Map();
  const pwTest = { id: 'test-id', title: 'retry isolation' };
  const createResult = (retry) => ({
    retry,
    stdout: [],
    stderr: [],
    steps: [{ startTime: new Date() }],
    attachments: [],
  });
  const firstResult = createResult(0);
  const retryResult = createResult(1);
  const attachSession = (result, sessionId) => {
    reporter.handleStdOutChunk(
      JSON.stringify({
        eventType: EVENT_NAMES.ATTACH_TEST_SESSION_CAPABILITIES,
        payload: {
          sessionId,
          capabilities: { browserName: 'Safari', platformName: 'iOS' },
        },
      }),
      pwTest,
      result,
    );
  };

  attachSession(firstResult, 'first-session');
  attachSession(retryResult, 'retry-session');

  const firstState = reporter.pwTestResultToState.get(firstResult);
  const retryState = reporter.pwTestResultToState.get(retryResult);
  assert.notEqual(firstState, retryState);
  assert.equal(firstState.providerSessionId, 'first-session');
  assert.equal(retryState.providerSessionId, 'retry-session');

  await reporter.releasePwTestBuffers(firstState, firstResult);

  assert.equal(reporter.pwTestResultToState.size, 1);
  assert.equal(retryState.providerSessionId, 'retry-session');

  await reporter.releasePwTestBuffers(retryState, retryResult);
  assert.equal(reporter.pwTestResultToState.size, 0);
});

test('contains a failed report while still releasing attempt state', async () => {
  const reporter = new Reporter();
  reporter.reportingConfig = { enabled: true };
  reporter.pwTestIdToZbrFinishedTry = new Map();
  reporter.reportTestEnd = async () => {
    throw new Error('upload failed');
  };
  const pwTest = { id: 'test-id', title: 'failed reporting' };
  const result = {
    retry: 0,
    stdout: [],
    stderr: [],
    steps: [],
    attachments: [],
  };

  const restoreLog = console.log;
  console.log = () => {};
  try {
    // Reporting is best-effort: onTestEnd must resolve so the run continues instead of aborting.
    await reporter.onTestEnd(pwTest, result);
  } finally {
    console.log = restoreLog;
  }

  assert.equal(reporter.errors.get('onTestEnd'), 1);
  assert.equal(reporter.pwTestResultToState.size, 0);
  assert.equal(reporter.pwTestIdToZbrFinishedTry.get('test-id'), 0);
});
