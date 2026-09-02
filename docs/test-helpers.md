# Test helpers

Helpers on `currentTest` for logs, screenshots, actions, and remote sessions.

## Screenshots and video

- `currentTest.attachScreenshot(pathOrBuffer)` attaches a PNG screenshot.
- `currentTest.attachVideo(pathOrBuffer, name?)` attaches a video file or buffer.

## Runtime actions

`currentTest.attachAction` sends typed runtime actions to the reporter. Each
action has an ID, kind, method, bounded parameters, start and end timestamps,
status, optional source location, and optional error.

Supported action kinds:

- `playwright`: enriched Playwright commands such as `page.goto`
- `bridge`: explicit `page.bridge.*` commands
- `appium`: explicit page or locator Appium commands
- `fixture`: library lifecycle operations tagged as fixtures

Start and completion events merge by action ID.
Parameters are emitted only on the start event.
Buffers and typed arrays are summarized.
Aggregate parameters are bounded.
Circular values cannot retain the original object graph.

Credentials, authorization headers, cookies, sensitive query parameters, and
known input values are redacted before logs are uploaded.

## Remote sessions

`currentTest.attachSessionCapabilities(capabilities, sessionId?)` creates a
test session with Browser and Platform metadata using the provider session id.

An optional `zebrunner:provider` capability, or the session endpoint, sets the
session provider. Provider is display metadata only.
It is not required for artifact attachment.

If `video.mp4` or `session.log` already exist in the bucket under that session
id, Zebrunner attaches them to the test.
A session omits browser version when none is known.

Reporter behavior for remote sessions:

- Per-retry test state resets only after the previous `onTestEnd` finishes.
  Labels, artifacts, videos, and session capabilities do not leak from an
  earlier try.
- Tests register a Zebrunner test session using the `sessionId` label and
  its capabilities. Session artifacts stay on S3. Zebrunner binds them by
  session id. The reporter does not download or re-upload them.
- Test metadata is initialized before stdout events are handled, so early
  fixture events are retained.
- Interrupted or aborted launches finish best-effort. Tune waits with
  `ZBR_FINISH_WAIT_TIMEOUT_MS` and `ZBR_ABORT_FINISH_TIMEOUT_MS`.
