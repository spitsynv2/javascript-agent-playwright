# Configuring Playwright test runs

This note covers RAM, screenshots, and log upload during a Playwright run.

## Screenshots

`currentTest.attachScreenshot` keeps PNG format.
The worker writes the image to a temp file.
The reporter sends the file as a stream.
It deletes the file after a successful upload.
One screenshot upload runs at a time for each test.

`page.screenshot()` still creates a Buffer in the Playwright worker.
V8 can keep worker RSS until the worker process exits.

Manual PNG screenshots upload during the test after the Zebrunner test id exists.
Videos and the test result still upload at test end.

## RAM peak

The client RAM peak follows Playwright `workers`.
Screenshot count has little effect on that peak.

A remote browser on a grid does not use RAM on the Playwright client.
The client still holds one Node worker per parallel test.

## Small client

On a small Playwright client, lower `workers` in Playwright config or CI.

```ts
export default defineConfig({
  workers: process.env.CI ? 10 : undefined,
});
```

On a 4 GB client, about 10–12 workers left headroom in CDP stress runs.
More workers can fill the client even with no screenshots.

## Logs during a run

`playwright-title` is the short log format. Use it when the timeline should
show only readable test commands.

With `includeHooks: false`, bridge actions from setup or teardown are hidden
even when `includeBridgeActions` is enabled. Bridge commands in the test body
stay visible. Appium actions and enriched Playwright navigation actions stay
visible unless their hook is excluded.

`logs.flushIntervalMs` uploads buffered logs while the test still runs.
Source files are cached only while one attempt is normalized.

When a test times out during an action that is still in progress, the reporter
finalizes that action at test end. It renders the action as `ERROR` with
`Test timed out while executing this action.` plus the Playwright timeout reason.
A completed action is never relabeled merely because it was the last recorded action.
