import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics, platformOf, syncSettled } from "./analytics.ts";

type Sent = { url: string; headers: Record<string, string>; body: any };

async function setup(over: { fail?: boolean; dir?: string; defaultOn?: boolean } = {}) {
  const dir = over.dir ?? (await mkdtemp(join(tmpdir(), "dosya-analytics-")));
  const sent: Sent[] = [];
  const clock = { t: 1_800_000_000_000 };
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    if (over.fail) throw new Error("offline");
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const analytics = new Analytics({
    dir, apiBase: "https://api.dosya.dev", platform: "macos", version: "3.1.11", channel: "direct",
    locale: () => "de", fetchImpl, now: () => clock.t, defaultOn: over.defaultOn,
  });
  await analytics.load();
  const names = () => sent.flatMap((s) => s.body.events.map((e: { name: string }) => e.name));
  const stored = async () => JSON.parse(await readFile(join(dir, "analytics.json"), "utf8"));
  return { analytics, sent, clock, dir, names, stored };
}

test("is on from the first launch, with no question asked", async () => {
  const { analytics, names, stored } = await setup();
  assert.equal(analytics.consent(), "granted");
  analytics.track("share_create");
  await analytics.flush();
  assert.deepEqual(names(), ["app_open", "share_create"]);
  const file = await stored();
  assert.equal(file.consent, true);
  assert.match(file.clientId, /^[0-9]{1,12}\.[0-9]{1,12}$/);
});

test("stays off under the test harness, and a stored yes still counts there", async () => {
  const { analytics, sent, dir } = await setup({ defaultOn: false });
  assert.equal(analytics.consent(), "denied");
  analytics.track("share_create");
  analytics.track("page_view", { screen: "/files" });
  analytics.syncSettled();
  await analytics.flush();
  assert.deepEqual(sent, []);
  await analytics.setConsent(true);
  const again = await setup({ dir, defaultOn: false });
  assert.equal(again.analytics.consent(), "granted");
});

test("collects nothing after a no, and remembers the no across launches", async () => {
  const { analytics, sent, dir, stored } = await setup();
  assert.equal(await analytics.setConsent(false), "denied");
  analytics.track("share_create");
  await analytics.flush();
  assert.deepEqual(sent, []);
  assert.deepEqual(await stored(), { consent: false });
  const again = await setup({ dir });
  assert.equal(again.analytics.consent(), "denied");
});

test("starts on a yes with a random install id, kept across launches", async () => {
  const { analytics, sent, dir, stored, names } = await setup();
  assert.equal(await analytics.setConsent(true), "granted");
  await analytics.flush();
  const { clientId } = await stored();
  assert.match(clientId, /^[0-9]{1,12}\.[0-9]{1,12}$/);
  assert.equal(sent[0].body.client_id, clientId);
  assert.deepEqual(names(), ["app_open"]);
  const again = await setup({ dir });
  assert.equal(again.analytics.consent(), "granted");
  await again.analytics.flush();
  assert.equal(again.sent[0].body.client_id, clientId);
});

test("drops what was waiting and forgets the id when consent is withdrawn", async () => {
  const { analytics, sent, stored } = await setup();
  await analytics.setConsent(true);
  analytics.track("share_create");
  await analytics.setConsent(false);
  await analytics.flush();
  assert.deepEqual(sent, []);
  assert.deepEqual(await stored(), { consent: false });
});

test("a broken file may hold a no: nothing is sent and the file is left alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-analytics-"));
  await writeFile(join(dir, "analytics.json"), "{not json", "utf8");
  const { analytics, sent } = await setup({ dir });
  assert.equal(analytics.consent(), "denied");
  analytics.track("share_create");
  await analytics.flush();
  assert.deepEqual(sent, []);
  assert.equal(await readFile(join(dir, "analytics.json"), "utf8"), "{not json");
});

test("posts a batch to the relay with no cookie on it", async () => {
  const { analytics, sent, clock } = await setup();
  await analytics.setConsent(true);
  await analytics.flush();
  sent.length = 0;
  analytics.setFocused(true);
  analytics.track("folder_create");
  clock.t += 7000;
  await analytics.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.dosya.dev/api/analytics/collect");
  assert.deepEqual(sent[0].headers, { "Content-Type": "application/json", "X-Dosya-Client": "desktop/3.1.11" });
  const { client_id, session_id, ...rest } = sent[0].body;
  assert.match(session_id, /^[0-9]+$/);
  assert.ok(client_id);
  assert.deepEqual(rest, {
    consent: true, platform: "macos", app_version: "3.1.11", channel: "direct", engagement_ms: 7000, locale: "de",
    events: [{ name: "folder_create", at: 1_800_000_000_000 }],
  });
});

test("keeps only category-shaped parameters", async () => {
  const { analytics, sent } = await setup();
  await analytics.setConsent(true);
  await analytics.flush();
  sent.length = 0;
  analytics.track("file_upload", { size_band: "1_10mb", name: "passport scan.pdf", nested: { a: 1 }, "Bad Key": "x" });
  analytics.track("Opened passport.pdf");
  analytics.track(42);
  await analytics.flush();
  assert.deepEqual(sent[0].body.events.map((e: any) => [e.name, e.params]), [["file_upload", { size_band: "1_10mb" }]]);
  assert.ok(!JSON.stringify(sent).includes("passport"));
});

test("counts a screen once while it stays in front", async () => {
  const { analytics, sent } = await setup();
  await analytics.setConsent(true);
  await analytics.flush();
  sent.length = 0;
  analytics.track("page_view", { screen: "/files" });
  analytics.track("page_view", { screen: "/files" });
  analytics.track("page_view", { screen: "/sync" });
  analytics.track("page_view", {});
  await analytics.flush();
  assert.deepEqual(sent[0].body.events.map((e: any) => e.params.screen), ["/files", "/sync"]);
});

test("starts a new visit after half an hour of silence", async () => {
  const { analytics, sent, clock } = await setup();
  await analytics.setConsent(true);
  analytics.track("folder_create");
  await analytics.flush();
  const first = sent[0].body.session_id;
  clock.t += 10 * 60 * 1000;
  analytics.track("folder_create");
  await analytics.flush();
  assert.equal(sent[1].body.session_id, first);
  clock.t += 31 * 60 * 1000;
  analytics.track("folder_create");
  await analytics.flush();
  assert.notEqual(sent[2].body.session_id, first);
});

test("counts a sync run at most once per quarter hour", async () => {
  const { analytics, clock, names } = await setup();
  await analytics.setConsent(true);
  analytics.syncSettled();
  analytics.syncSettled();
  clock.t += 16 * 60 * 1000;
  analytics.syncSettled("error");
  await analytics.flush();
  assert.deepEqual(names().filter((n) => n === "sync_complete").length, 2);
});

test("losing focus sends what is waiting, with the time in front", async () => {
  const { analytics, sent, clock } = await setup();
  await analytics.setConsent(true);
  await analytics.flush();
  sent.length = 0;
  analytics.setFocused(true);
  analytics.track("share_create");
  clock.t += 12_000;
  analytics.setFocused(false);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.engagement_ms, 12_000);
});

test("sends a full batch at once and the rest after", async () => {
  const { analytics, sent } = await setup();
  await analytics.setConsent(true);
  await analytics.flush();
  sent.length = 0;
  for (let i = 0; i < 30; i++) analytics.track("folder_create");
  await analytics.flush();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((s) => s.body.events.length), [25, 5]);
});

test("stays silent offline and does not resend the lost batch", async () => {
  const { analytics, sent } = await setup({ fail: true });
  await analytics.setConsent(true);
  analytics.track("share_create");
  await assert.doesNotReject(analytics.flush());
  assert.deepEqual(sent, []);
});

test("platformOf names the three systems the relay knows", () => {
  assert.equal(platformOf("darwin"), "macos");
  assert.equal(platformOf("win32"), "windows");
  assert.equal(platformOf("linux"), "linux");
  assert.equal(platformOf("freebsd"), null);
});

test("syncSettled is the edge from syncing to anything else", () => {
  const syncing = { pairs: [{ pairId: "a", status: "syncing" }] };
  const idle = { pairs: [{ pairId: "a", status: "idle" }] };
  assert.equal(syncSettled(null, idle), false);
  assert.equal(syncSettled(idle, idle), false);
  assert.equal(syncSettled(syncing, syncing), false);
  assert.equal(syncSettled(syncing, idle), true);
  assert.equal(syncSettled(syncing, { pairs: [{ pairId: "a", status: "error" }] }), true);
});
