import test from "node:test";
import assert from "node:assert/strict";
import {
  linkFileProvider,
  relinkFileProvider,
  unlinkFileProvider,
  signalFileProvider,
  __resetFileProviderLink,
} from "./file-provider.ts";
import type { FileProviderNative, MintedSession } from "./file-provider.ts";

interface Fake extends FileProviderNative {
  calls: string[];
  written: string[];
}

function fakeNative(stored: string | null = null): Fake {
  const calls: string[] = [];
  let current = stored;
  const native: Fake = {
    calls,
    written: [],
    isSupported: () => true,
    storedUserId: () => current,
    writeSession: (json: string) => {
      calls.push("writeSession");
      native.written.push(json);
      current = (JSON.parse(json) as { userId?: string }).userId ?? null;
    },
    clearSession: () => {
      calls.push("clearSession");
      current = null;
    },
    registerDomain: async () => {
      calls.push("registerDomain");
      return true;
    },
    removeDomain: async () => {
      calls.push("removeDomain");
      return true;
    },
    signalChanges: async () => {
      calls.push("signalChanges");
      return true;
    },
    domainEnabled: async () => {
      calls.push("domainEnabled");
      return true;
    },
  };
  return native;
}

const minted: MintedSession = { access: "a", refresh: "r", apiBaseUrl: "http://api" };
const neverMints = async (): Promise<MintedSession> => {
  throw new Error("the mint must not be called here");
};

test("a first link mints, writes and registers", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  let mints = 0;
  await linkFileProvider("u1", {
    native,
    mint: async () => {
      mints += 1;
      return minted;
    },
  });
  assert.equal(mints, 1);
  assert.deepEqual(native.calls, ["writeSession", "registerDomain"]);
  assert.deepEqual(JSON.parse(native.written[0]), {
    access: "a",
    refresh: "r",
    apiBaseUrl: "http://api",
    userId: "u1",
  });
});

test("two links for the same account mint once", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  let mints = 0;
  const mint = async (): Promise<MintedSession> => {
    mints += 1;
    await new Promise((r) => setTimeout(r, 10));
    return minted;
  };
  await Promise.all([linkFileProvider("u1", { native, mint }), linkFileProvider("u1", { native, mint })]);
  assert.equal(mints, 1, "the second mint would revoke the first and leave a dead session");
});

test("a stored session for this account is kept", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative("u1");
  await linkFileProvider("u1", { native, mint: neverMints });
  assert.deepEqual(native.calls, ["registerDomain", "signalChanges"]);
});

test("a fresh sign-in re-mints over a stored session for the same account", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative("u1");
  let mints = 0;
  await relinkFileProvider("u1", {
    native,
    mint: async () => {
      mints += 1;
      return { access: "a2", refresh: "r2", apiBaseUrl: "http://api" };
    },
  });
  assert.equal(mints, 1);
  assert.deepEqual(native.calls, ["writeSession", "registerDomain"]);
});

test("another account's session and its downloaded files go first", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative("other");
  await linkFileProvider("u1", { native, mint: async () => minted });
  assert.deepEqual(native.calls, ["clearSession", "removeDomain", "writeSession", "registerDomain"]);
});

test("a failed mint leaves the stored session alone", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative("u1");
  await relinkFileProvider("u1", {
    native,
    mint: async () => {
      throw new Error("offline");
    },
  });
  assert.ok(!native.calls.includes("clearSession"));
  assert.ok(!native.calls.includes("writeSession"));
  assert.equal(native.storedUserId(), "u1");
});

test("an unlink during a link ends with no domain", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  const mint = async (): Promise<MintedSession> => {
    await new Promise((r) => setTimeout(r, 10));
    return minted;
  };
  const linking = linkFileProvider("u1", { native, mint });
  const unlinking = unlinkFileProvider(null, { native, mint });
  await Promise.all([linking, unlinking]);
  assert.equal(native.calls.at(-1), "removeDomain", "the purge must not land before the link it follows");
  assert.equal(native.storedUserId(), null);
});

test("an unlink for another account leaves this one signed in", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative("u2");
  await unlinkFileProvider("u1", { native, mint: neverMints });
  assert.deepEqual(native.calls, []);
});

test("a missing addon is not an error", async (t) => {
  t.after(__resetFileProviderLink);
  await linkFileProvider("u1", { native: null, mint: neverMints });
  await unlinkFileProvider(null, { native: null, mint: neverMints });
  await signalFileProvider({ native: null, mint: neverMints });
});

test("a platform that cannot offer a location does nothing", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  native.isSupported = () => false;
  await linkFileProvider("u1", { native, mint: neverMints });
  assert.deepEqual(native.calls, []);
});

test("a native call that never settles does not wedge the queue", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  native.registerDomain = () => new Promise<boolean>(() => {});
  await linkFileProvider("u1", { native, mint: async () => minted, waitMs: 20 });

  const second = fakeNative("u1");
  await linkFileProvider("u1", { native: second, mint: neverMints });
  assert.ok(second.calls.includes("registerDomain"), "the next call still runs");
});

test("a native call that throws is swallowed", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  native.registerDomain = async () => {
    throw new Error("fileproviderd said no");
  };
  await linkFileProvider("u1", { native, mint: async () => minted });
  assert.deepEqual(native.calls, ["writeSession"]);
});

// ── Findings from the whole-branch review ─────────────────────────────

test("a stalled mint does not hold sign-out behind it", { timeout: 5000 }, async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  // The module's contract is that nothing here blocks sign-out. The mint is an
  // unbounded fetch, and unlink shares the queue, so an unbounded mint holds the
  // sign-out teardown that auth:clear-session awaits.
  const linking = linkFileProvider("u1", { native, mint: () => new Promise<MintedSession>(() => {}), waitMs: 20 });
  const unlinking = unlinkFileProvider(null, { native, mint: neverMints, waitMs: 20 });
  await Promise.all([linking, unlinking]);
  assert.deepEqual(native.calls, ["clearSession", "removeDomain"]);
});

test("a link after an unlink is not deduped into the one that already ran", async (t) => {
  t.after(__resetFileProviderLink);
  const native = fakeNative();
  let mints = 0;
  const mint = async (): Promise<MintedSession> => {
    mints += 1;
    await new Promise((r) => setTimeout(r, 10));
    return minted;
  };
  // Turning the switch off and on again while the sign-in link is still minting.
  const first = linkFileProvider("u1", { native, mint });
  const off = unlinkFileProvider(null, { native, mint });
  const again = linkFileProvider("u1", { native, mint });
  await Promise.all([first, off, again]);
  assert.equal(mints, 2, "the third call must not be handed the first call's promise");
  assert.equal(native.storedUserId(), "u1");
  assert.equal(native.calls.at(-1), "registerDomain", "it must end with a location, not without one");
});

test("a link reports whether it actually linked", async (t) => {
  t.after(__resetFileProviderLink);
  assert.equal(await linkFileProvider("u1", { native: fakeNative(), mint: async () => minted }), true);
  __resetFileProviderLink();
  assert.equal(
    await linkFileProvider("u1", {
      native: fakeNative(),
      mint: async () => {
        throw new Error("offline");
      },
    }),
    false,
    "a caller that reports success it cannot know about makes the switch lie",
  );
  __resetFileProviderLink();
  assert.equal(await linkFileProvider("u1", { native: null, mint: neverMints }), false);
});
