import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SENTRY_DSN,
  isSentryEnabled,
  releaseName,
  resolveDsn,
  scrubEvent,
} from "./telemetry-config.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * These pin the three decisions that decide whether a user's crash reaches
 * the dashboard and what travels with it: which DSN, whether this build is
 * allowed to send at all, and which personal fields are stripped first.
 */

test("the checked-in DSN is used when nothing is configured", () => {
  assert.equal(resolveDsn({}), DEFAULT_SENTRY_DSN);
});

test("DOSYA_SENTRY_DSN overrides the default, trimmed", () => {
  assert.equal(resolveDsn({ DOSYA_SENTRY_DSN: "  https://k@o1.ingest.de.sentry.io/2 " }), "https://k@o1.ingest.de.sentry.io/2");
});

test("an empty DOSYA_SENTRY_DSN switches reporting off", () => {
  assert.equal(resolveDsn({ DOSYA_SENTRY_DSN: "" }), null);
  assert.equal(resolveDsn({ DOSYA_SENTRY_DSN: "   " }), null);
  assert.equal(isSentryEnabled({ DOSYA_SENTRY_DSN: "" }, true), false);
});

test("packaged builds report; dev runs do not unless DOSYA_SENTRY_DEV=1", () => {
  assert.equal(isSentryEnabled({}, true), true);
  assert.equal(isSentryEnabled({}, false), false);
  assert.equal(isSentryEnabled({ DOSYA_SENTRY_DEV: "1" }, false), true);
  assert.equal(isSentryEnabled({ DOSYA_SENTRY_DEV: "0" }, false), false);
});

test("scrubEvent keeps only the opaque user id and drops the hostname", () => {
  const event = scrubEvent({
    user: { id: "usr_abc", email: "a@example.com", username: "firat", ip_address: "1.2.3.4" },
    server_name: "Firats-MacBook-Pro",
    message: "boom",
  });
  assert.deepEqual(event.user, { id: "usr_abc" });
  assert.equal("server_name" in event, false);
  assert.equal(event.message, "boom");
});

test("scrubEvent removes a user block that has no id at all", () => {
  const event = scrubEvent({ user: { email: "a@example.com" } });
  assert.equal(event.user, undefined);
});

test("scrubEvent leaves an event with no user untouched", () => {
  assert.deepEqual(scrubEvent({ message: "x" }), { message: "x" });
});

test("release name is the one the source-map upload uses", () => {
  assert.equal(releaseName("3.1.0"), "dosya-desktop@3.1.0");
});
