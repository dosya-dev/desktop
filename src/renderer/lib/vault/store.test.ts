import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVault, type E2eeEngine, type EncryptedEntry, type KnownWorkspace } from "./store";
import { setActiveGlobalWorkspaceId } from "./active-workspace";
import { ApiError } from "@/lib/api-client";
import { SESSION_RESET_EVENT } from "@/lib/session-reset";

// The store's module-level initial state constructs the REAL engine
// (`defaultEngine()`), which builds its API client against the IPC-primed
// API base (see client.ts's `buildE2eeClient`) - unprimed in this test
// environment (no main process). Every test below swaps in a fake engine via
// `__setEngine` before exercising the store, so only the base needs a value
// for the module to import cleanly. (Vitest hoists `vi.mock` above the
// imports above, so this is in effect before "./store" is loaded.)
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test" };
});

// jsdom (this vitest env, v25.0.1) implements Blob/File storage but not the
// async read methods (`arrayBuffer`/`text`) real browsers have long shipped -
// only `FileReader` can pull bytes out. Polyfill just enough for the
// `uploadFiles` test below to exercise the SAME `file.arrayBuffer()` call the
// production store code makes; this is a test-environment shim only, never
// shipped, and does not change what the store does in a real browser.
if (typeof File.prototype.arrayBuffer !== "function") {
  File.prototype.arrayBuffer = function (this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

function makeFakeEngine(overrides: Partial<E2eeEngine> = {}): E2eeEngine {
  return {
    hasIdentity: async () => true,
    setup: async () => ({ recoveryKeyHex: "ab12" }),
    unlock: async () => {},
    lock: () => {},
    createWorkspace: async () => {},
    readWorkspaceName: async () => null, readWorkspaceNameById: async () => null,
    renameWorkspace: async () => {},
    setWorkspaceScope: async () => {},
    openWorkspace: async () => {},
    listFolder: async () => [],
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
    listMembers: async () => [],
    inviteMember: async () => {},
    revokeMember: async () => {},
    listMyWorkspaces: async () => [],
    unlockWithRecoveryKey: async () => {},
    destroyIdentity: async () => {},
    ...overrides,
  };
}

/** Reset every field the tests touch between cases (actions live on the same object and are untouched by a partial setState). */
beforeEach(() => {
  localStorage.clear();
  useVault.setState({
    status: "locked",
    error: null,
    hasIdentity: null,
    workspaces: [],
    activeWorkspaceId: null,
    entries: [],
    busy: false,
    recoveryKeyOnce: null,
    members: [],
    ownerUserId: null,
  });
  useVault.getState().__setSaver(async () => ({ ok: true, path: "/tmp/x" }));
  // The active GLOBAL workspace (active-workspace.ts) - reset to its default
  // between cases; individual tests below set it explicitly where the active
  // workspace matters.
  setActiveGlobalWorkspaceId(null);
});

describe("useVault: unlock", () => {
  it("success sets status=unlocked and clears error", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ unlock: async () => {} }));

    await useVault.getState().unlock("correct horse battery staple");

    expect(useVault.getState().status).toBe("unlocked");
    expect(useVault.getState().error).toBeNull();
  });

  it("failure sets status=locked and a GENERIC error that never leaks the engine's message", async () => {
    useVault.getState().__setEngine(
      makeFakeEngine({
        unlock: async () => {
          throw new Error("e2ee: unlock failed");
        },
      }),
    );

    await useVault.getState().unlock("wrong passphrase");

    expect(useVault.getState().status).toBe("locked");
    expect(useVault.getState().error).toBe("Incorrect passphrase or no identity found.");
    // No-leak: the surfaced message must not contain the engine's raw text.
    expect(useVault.getState().error).not.toContain("unlock failed");
  });
});

describe("useVault: setup", () => {
  it("success sets status=unlocked and recoveryKeyOnce; dismissRecoveryKey clears it", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ setup: async () => ({ recoveryKeyHex: "ab12" }) }));

    await useVault.getState().setup("a brand new passphrase");

    expect(useVault.getState().status).toBe("unlocked");
    expect(useVault.getState().recoveryKeyOnce).toBe("ab12");

    useVault.getState().dismissRecoveryKey();

    expect(useVault.getState().recoveryKeyOnce).toBeNull();
  });
});

describe("useVault: createWorkspace", () => {
  it("adds {id,name,selfFounded:true,shared:false,globalWorkspaceId} to workspaces and makes it the active workspace", async () => {
    setActiveGlobalWorkspaceId("gw-1");
    useVault.getState().__setEngine(makeFakeEngine({ createWorkspace: async () => {} }));

    await useVault.getState().createWorkspace("Docs");

    const { workspaces, activeWorkspaceId } = useVault.getState();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("Docs");
    expect(workspaces[0].id).toBeTruthy();
    // Security-critical: a workspace THIS account created is hard-anchored -
    // selfFounded must be true, and (per the store's own persisted-state
    // source of truth) it is set here, never derived from anything the
    // server returns.
    expect(workspaces[0].selfFounded).toBe(true);
    // P2e: scoped to the ACTIVE global workspace at creation time - read
    // from active-workspace.ts, display-only, never affects selfFounded above.
    expect(workspaces[0].globalWorkspaceId).toBe("gw-1");
    expect(workspaces[0].shared).toBe(false);
    expect(activeWorkspaceId).toBe(workspaces[0].id);
  });

  it("records the workspace scope via engine.setWorkspaceScope(id, activeGlobalId)", async () => {
    setActiveGlobalWorkspaceId("gw-1");
    let seenScope: { workspaceId: string; globalWorkspaceId: string } | null = null;
    useVault.getState().__setEngine(
      makeFakeEngine({
        setWorkspaceScope: async (workspaceId, globalWorkspaceId) => {
          seenScope = { workspaceId, globalWorkspaceId };
        },
      }),
    );

    await useVault.getState().createWorkspace("Docs");

    const { workspaces } = useVault.getState();
    expect(seenScope).toEqual({ workspaceId: workspaces[0].id, globalWorkspaceId: "gw-1" });
  });
});

/**
 * A Space's name lives in the Space now, sealed under its own key. This
 * machine's list is a cache of it, and opening a Space is where the two are
 * made to agree.
 */
describe("useVault: the name this machine shows for a Space", () => {
  it("takes the Space's own name over the placeholder it invented", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ readWorkspaceName: async () => "Tax 2026" }));
    useVault.setState({
      workspaces: [
        { id: "ws-1", name: "Space", selfFounded: false, shared: false, globalWorkspaceId: "gw-1", stub: true },
      ],
      activeWorkspaceId: "ws-1",
    });

    await useVault.getState().reconcileWorkspaceName("ws-1");

    expect(useVault.getState().workspaces[0]).toMatchObject({ name: "Tax 2026", stub: false });
  });

  it("writes THIS machine's name into a Space that has none, so an older Space gets its label with nobody retyping it", async () => {
    const renamed: (string | null)[] = [];
    useVault.getState().__setEngine(
      makeFakeEngine({
        readWorkspaceName: async () => null,
        renameWorkspace: async (name) => { renamed.push(name); },
      }),
    );
    useVault.setState({
      workspaces: [{ id: "ws-old", name: "Receipts", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" }],
      activeWorkspaceId: "ws-old",
    });

    await useVault.getState().reconcileWorkspaceName("ws-old");

    expect(renamed).toEqual(["Receipts"]);
  });

  it("never promotes a placeholder into the Space", async () => {
    const renamed: (string | null)[] = [];
    useVault.getState().__setEngine(
      makeFakeEngine({
        readWorkspaceName: async () => null,
        renameWorkspace: async (name) => { renamed.push(name); },
      }),
    );
    useVault.setState({
      workspaces: [
        { id: "ws-d", name: "Shared Space", selfFounded: false, shared: true, globalWorkspaceId: "gw-1", stub: true },
      ],
      activeWorkspaceId: "ws-d",
    });

    await useVault.getState().reconcileWorkspaceName("ws-d");

    expect(renamed).toEqual([]);
    expect(useVault.getState().workspaces[0]!.name).toBe("Shared Space");
  });

  it("says nothing when the Space will not answer: a label is not worth an error over a Space that opened", async () => {
    useVault.getState().__setEngine(
      makeFakeEngine({ readWorkspaceName: async () => { throw new Error("offline"); } }),
    );
    useVault.setState({
      workspaces: [{ id: "ws-1", name: "Receipts", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" }],
      activeWorkspaceId: "ws-1",
      error: null,
    });

    await useVault.getState().reconcileWorkspaceName("ws-1");

    expect(useVault.getState().error).toBeNull();
    expect(useVault.getState().workspaces[0]!.name).toBe("Receipts");
  });
});

describe("useVault: refreshMyWorkspaces", () => {
  it("adds a discovered createdByMe:false entry as {shared:true, selfFounded:false} with its globalWorkspaceId", async () => {
    useVault.getState().__setEngine(
      makeFakeEngine({
        listMyWorkspaces: async () => [
          { workspaceId: "ws-shared-1", globalWorkspaceId: "gw-1", createdByMe: false },
        ],
      }),
    );

    await useVault.getState().refreshMyWorkspaces();

    const { workspaces } = useVault.getState();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toEqual({
      id: "ws-shared-1",
      name: "Shared Space",
      globalWorkspaceId: "gw-1",
      shared: true,
      selfFounded: false,
      // Invented here, so never written into the Space.
      stub: true,
    });
  });

  it("adds a discovered createdByMe:true entry as {shared:false, selfFounded:false} -- SECURITY: createdByMe is server-reported and display-only, it must NEVER set selfFounded:true (that is reserved for this client's OWN createWorkspace call -- see the P2e forge-defense invariant)", async () => {
    useVault.getState().__setEngine(
      makeFakeEngine({
        listMyWorkspaces: async () => [
          { workspaceId: "ws-other-device", globalWorkspaceId: "gw-2", createdByMe: true },
        ],
      }),
    );

    await useVault.getState().refreshMyWorkspaces();

    const { workspaces } = useVault.getState();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toEqual({
      id: "ws-other-device",
      name: "Space",
      globalWorkspaceId: "gw-2",
      shared: false,
      selfFounded: false,
      stub: true,
    });
    // Explicit, isolated assertion of the security invariant: a
    // createdByMe:true discovered entry must NOT become selfFounded:true.
    expect(workspaces[0].selfFounded).toBe(false);
  });

  it("does NOT overwrite an existing created workspace's selfFounded:true (or its globalWorkspaceId), even if the server also lists it in my-workspaces with createdByMe:true (forge-resistance)", async () => {
    useVault.setState({
      workspaces: [
        { id: "ws-mine", name: "Docs", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" },
      ],
    });
    useVault.getState().__setEngine(
      makeFakeEngine({
        listMyWorkspaces: async () => [
          { workspaceId: "ws-mine", globalWorkspaceId: "gw-1", createdByMe: true },
          { workspaceId: "ws-shared-1", globalWorkspaceId: "gw-1", createdByMe: false },
        ],
      }),
    );

    await useVault.getState().refreshMyWorkspaces();

    const { workspaces } = useVault.getState();
    expect(workspaces).toHaveLength(2);
    const mine = workspaces.find((w) => w.id === "ws-mine");
    const shared = workspaces.find((w) => w.id === "ws-shared-1");
    expect(mine?.selfFounded).toBe(true);
    expect(mine?.name).toBe("Docs");
    expect(mine?.globalWorkspaceId).toBe("gw-1");
    expect(shared).toEqual({
      id: "ws-shared-1",
      name: "Shared Space",
      globalWorkspaceId: "gw-1",
      shared: true,
      selfFounded: false,
      // Invented here, so never written into the Space.
      stub: true,
    });
  });
});

describe("useVault: mySpacesForActiveWorkspace / sharedSpaces selectors", () => {
  const workspaces: KnownWorkspace[] = [
    { id: "ws-a", name: "Docs", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" },
    { id: "ws-b", name: "Other Space", selfFounded: false, shared: false, globalWorkspaceId: "gw-2" },
    { id: "ws-legacy", name: "Legacy", selfFounded: true, shared: false, globalWorkspaceId: null },
    { id: "ws-shared", name: "Shared Space", selfFounded: false, shared: true, globalWorkspaceId: "gw-1" },
  ];

  it("mySpacesForActiveWorkspace returns only non-shared entries matching the active global id, plus null-scope legacy fallback", () => {
    setActiveGlobalWorkspaceId("gw-1");
    useVault.setState({ workspaces });

    const mine = useVault.getState().mySpacesForActiveWorkspace();

    expect(mine.map((w) => w.id).sort()).toEqual(["ws-a", "ws-legacy"].sort());
  });

  it("mySpacesForActiveWorkspace excludes a non-shared Space scoped to a DIFFERENT global workspace", () => {
    setActiveGlobalWorkspaceId("gw-2");
    useVault.setState({ workspaces });

    const mine = useVault.getState().mySpacesForActiveWorkspace();

    expect(mine.map((w) => w.id).sort()).toEqual(["ws-b", "ws-legacy"].sort());
  });

  it("sharedSpaces returns every shared:true entry regardless of the active global workspace", () => {
    setActiveGlobalWorkspaceId("gw-2");
    useVault.setState({ workspaces });

    const shared = useVault.getState().sharedSpaces();

    expect(shared.map((w) => w.id)).toEqual(["ws-shared"]);
  });
});

describe("useVault: openWorkspace (store action)", () => {
  it("passes the KnownWorkspace's stored selfFounded:true through to the engine", async () => {
    let seen: { id: string; selfFounded: boolean } | null = null;
    useVault.setState({
      workspaces: [{ id: "ws-mine", name: "Docs", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" }],
    });
    useVault.getState().__setEngine(
      makeFakeEngine({
        openWorkspace: async (id, selfFounded) => {
          seen = { id, selfFounded };
        },
      }),
    );

    await useVault.getState().openWorkspace("ws-mine");

    expect(seen).toEqual({ id: "ws-mine", selfFounded: true });
    expect(useVault.getState().activeWorkspaceId).toBe("ws-mine");
  });

  it("passes selfFounded:false for a known-shared workspace, and defaults to false (safe) for an unknown id", async () => {
    let seen: { id: string; selfFounded: boolean } | null = null;
    useVault.setState({
      workspaces: [
        { id: "ws-shared", name: "Shared workspace", selfFounded: false, shared: true, globalWorkspaceId: "gw-1" },
      ],
    });
    useVault.getState().__setEngine(
      makeFakeEngine({
        openWorkspace: async (id, selfFounded) => {
          seen = { id, selfFounded };
        },
      }),
    );

    await useVault.getState().openWorkspace("ws-shared");
    expect(seen).toEqual({ id: "ws-shared", selfFounded: false });

    await useVault.getState().openWorkspace("ws-never-seen-before");
    expect(seen).toEqual({ id: "ws-never-seen-before", selfFounded: false });
  });
});

describe("useVault: members (refreshMembers/inviteMember/revokeMember)", () => {
  const fakeMembers = [
    { userId: "u1", email: "a@example.com", ed25519Pub: "ed-a", x25519Pub: "x-a" },
    { userId: "u2", email: "b@example.com", ed25519Pub: "ed-b", x25519Pub: "x-b" },
  ];

  it("refreshMembers populates members from the engine", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ listMembers: async () => fakeMembers }));

    await useVault.getState().refreshMembers();

    expect(useVault.getState().members).toEqual(fakeMembers);
  });

  it("inviteMember calls the engine then refreshes members", async () => {
    let invitedEmail: string | null = null;
    useVault.getState().__setEngine(
      makeFakeEngine({
        inviteMember: async (email) => {
          invitedEmail = email;
        },
        listMembers: async () => fakeMembers,
      }),
    );

    await useVault.getState().inviteMember("new@example.com");

    expect(invitedEmail).toBe("new@example.com");
    expect(useVault.getState().members).toEqual(fakeMembers);
    expect(useVault.getState().busy).toBe(false);
    expect(useVault.getState().error).toBeNull();
  });

  it("inviteMember maps the engine's no-E2EE-identity error to a friendly message", async () => {
    useVault.getState().__setEngine(
      makeFakeEngine({
        inviteMember: async () => {
          throw new Error("e2ee: grantAccess: that user has no E2EE identity");
        },
      }),
    );

    await useVault.getState().inviteMember("nobody@example.com");

    expect(useVault.getState().error).toBe("That user hasn't set up encryption yet");
    expect(useVault.getState().busy).toBe(false);
  });

  it("revokeMember calls the engine with (userId, ed25519Pub) then refreshes members", async () => {
    let revoked: { userId: string; ed25519Pub: string } | null = null;
    useVault.getState().__setEngine(
      makeFakeEngine({
        revokeMember: async (userId, ed25519Pub) => {
          revoked = { userId, ed25519Pub };
        },
        listMembers: async () => [fakeMembers[0]],
      }),
    );

    await useVault.getState().revokeMember("u2", "ed-b");

    expect(revoked).toEqual({ userId: "u2", ed25519Pub: "ed-b" });
    expect(useVault.getState().members).toEqual([fakeMembers[0]]);
    expect(useVault.getState().busy).toBe(false);
  });
});

describe("useVault: refreshFolder", () => {
  it("populates entries from the engine's listFolder", async () => {
    const fakeEntries: EncryptedEntry[] = [
      { id: "1", name: "a.txt", kind: "file" },
      { id: "2", name: "sub", kind: "folder" },
    ];
    useVault.getState().__setEngine(makeFakeEngine({ listFolder: async () => fakeEntries }));

    await useVault.getState().refreshFolder();

    expect(useVault.getState().entries).toHaveLength(2);
  });
});

describe("useVault: lock", () => {
  it("clears entries/activeWorkspaceId/members, sets status=locked, and calls engine.lock()", async () => {
    let lockCalled = false;
    useVault.getState().__setEngine(
      makeFakeEngine({
        unlock: async () => {},
        listFolder: async () => [{ id: "1", name: "a.txt", kind: "file" }],
        listMembers: async () => [{ userId: "u1", email: "a@example.com", ed25519Pub: "ed-a", x25519Pub: "x-a" }],
        lock: () => {
          lockCalled = true;
        },
      }),
    );

    await useVault.getState().unlock("pass");
    useVault.setState({ activeWorkspaceId: "ws-1" });
    await useVault.getState().refreshFolder();
    await useVault.getState().refreshMembers();
    expect(useVault.getState().entries).toHaveLength(1);
    expect(useVault.getState().members).toHaveLength(1);

    useVault.getState().lock();

    expect(useVault.getState().status).toBe("locked");
    expect(useVault.getState().entries).toEqual([]);
    expect(useVault.getState().activeWorkspaceId).toBeNull();
    expect(useVault.getState().members).toEqual([]);
    expect(lockCalled).toBe(true);
  });
});

describe("useVault: checkIdentity", () => {
  it("success (identity exists) sets hasIdentity=true and clears error", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ hasIdentity: async () => true }));

    await useVault.getState().checkIdentity();

    expect(useVault.getState().hasIdentity).toBe(true);
    expect(useVault.getState().error).toBeNull();
  });

  it("success (no identity yet) sets hasIdentity=false and clears error", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ hasIdentity: async () => false }));

    await useVault.getState().checkIdentity();

    expect(useVault.getState().hasIdentity).toBe(false);
    expect(useVault.getState().error).toBeNull();
  });

  it("a transient error leaves hasIdentity=null (never false) and sets error - regression guard: showing Setup on a network blip lets setupIdentity silently overwrite real keys", async () => {
    useVault.getState().__setEngine(
      makeFakeEngine({
        hasIdentity: async () => {
          throw new Error("network blip");
        },
      }),
    );

    await useVault.getState().checkIdentity();

    expect(useVault.getState().hasIdentity).toBeNull();
    expect(useVault.getState().error).not.toBeNull();
  });
});

describe("useVault: uploadFiles", () => {
  it("uploads each file's bytes via the engine, then refreshes the folder", async () => {
    const uploadCalls: { folderId: string; name: string; text: string }[] = [];
    let listFolderCalled = false;
    useVault.getState().__setEngine(
      makeFakeEngine({
        uploadFile: async (folderId, name, bytes) => {
          uploadCalls.push({ folderId, name, text: new TextDecoder().decode(bytes) });
        },
        listFolder: async () => {
          listFolderCalled = true;
          return [{ id: "1", name: "a.txt", kind: "file" }];
        },
      }),
    );

    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    await useVault.getState().uploadFiles([file]);

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].name).toBe("a.txt");
    expect(uploadCalls[0].text).toBe("hello");
    expect(uploadCalls[0].folderId).toBe("");
    expect(listFolderCalled).toBe(true);
    expect(useVault.getState().entries).toHaveLength(1);
    expect(useVault.getState().busy).toBe(false);
  });
});

describe("useVault: uploadFiles attaches an unscoped Space and retries once", () => {
  const scopeRequired = () => new Error("e2ee: chunk-upload-url request failed (412)");

  it("on a 412, attaches the open Space to the active global workspace and uploads again", async () => {
    const scopeCalls: [string, string][] = [];
    let attempts = 0;
    useVault.getState().__setEngine(
      makeFakeEngine({
        uploadFile: async () => {
          attempts++;
          if (scopeCalls.length === 0) throw scopeRequired();
        },
        setWorkspaceScope: async (spaceId, gw) => {
          scopeCalls.push([spaceId, gw]);
        },
        listFolder: async () => [{ id: "1", name: "a.txt", kind: "file" }],
      }),
    );
    setActiveGlobalWorkspaceId("ws_active");
    useVault.setState({
      activeWorkspaceId: "sp_legacy",
      workspaces: [{ id: "sp_legacy", name: "Legacy", selfFounded: true, shared: false, globalWorkspaceId: null }],
    });

    await useVault.getState().uploadFiles([new File(["hello"], "a.txt", { type: "text/plain" })]);

    expect(scopeCalls).toEqual([["sp_legacy", "ws_active"]]);
    expect(attempts).toBe(2);
    expect(useVault.getState().error).toBeNull();
    expect(useVault.getState().entries).toHaveLength(1);
    // The local record follows, so the Space now lists under ws_active.
    expect(useVault.getState().workspaces[0].globalWorkspaceId).toBe("ws_active");
  });

  it("retries at most once - a 412 that survives the attach is reported, not looped", async () => {
    let attempts = 0;
    let scopeCalls = 0;
    useVault.getState().__setEngine(
      makeFakeEngine({
        uploadFile: async () => {
          attempts++;
          throw scopeRequired();
        },
        setWorkspaceScope: async () => {
          scopeCalls++;
        },
      }),
    );
    setActiveGlobalWorkspaceId("ws_active");
    useVault.setState({ activeWorkspaceId: "sp_1" });

    await useVault.getState().uploadFiles([new File(["hello"], "a.txt", { type: "text/plain" })]);

    expect(attempts).toBe(2);
    expect(scopeCalls).toBe(1);
    expect(useVault.getState().error).not.toBeNull();
    expect(useVault.getState().busy).toBe(false);
  });

  it("does not attach anything for an ordinary failure, or when no global workspace is active", async () => {
    let scopeCalls = 0;
    useVault.getState().__setEngine(
      makeFakeEngine({
        uploadFile: async () => {
          throw new Error("e2ee: commit request failed (500)");
        },
        setWorkspaceScope: async () => {
          scopeCalls++;
        },
      }),
    );
    setActiveGlobalWorkspaceId("ws_active");
    useVault.setState({ activeWorkspaceId: "sp_1" });
    await useVault.getState().uploadFiles([new File(["x"], "x.txt")]);
    expect(scopeCalls).toBe(0);

    useVault.getState().__setEngine(
      makeFakeEngine({
        uploadFile: async () => {
          throw scopeRequired();
        },
        setWorkspaceScope: async () => {
          scopeCalls++;
        },
      }),
    );
    setActiveGlobalWorkspaceId(null);
    await useVault.getState().uploadFiles([new File(["x"], "x.txt")]);
    expect(scopeCalls).toBe(0);
    expect(useVault.getState().error).not.toBeNull();
  });
});

describe("useVault: downloadEntry", () => {
  it("downloads bytes via the engine and hands them to the injected saver", async () => {
    const fakeBytes = new TextEncoder().encode("secret content");
    let downloadedArgs: [string, string] | null = null;
    useVault.getState().__setEngine(
      makeFakeEngine({
        downloadFile: async (_folderId, entryId) => {
          expect(entryId).toBe("id1");
          return fakeBytes;
        },
      }),
    );
    useVault.getState().__setSaver(async (name, bytes) => {
      downloadedArgs = [name, new TextDecoder().decode(bytes)];
      return { ok: true, path: "/Users/x/Downloads/a.txt" };
    });

    await useVault.getState().downloadEntry("id1", "a.txt");

    expect(downloadedArgs).toEqual(["a.txt", "secret content"]);
    expect(useVault.getState().busy).toBe(false);
    expect(useVault.getState().error).toBeNull();
  });

  it("clears busy before the save dialog opens, not after it closes", async () => {
    let busyWhileDialogOpen: boolean | null = null;
    useVault.getState().__setEngine(makeFakeEngine({ downloadFile: async () => new Uint8Array([1]) }));
    useVault.getState().__setSaver(async () => {
      busyWhileDialogOpen = useVault.getState().busy;
      return { ok: true, path: "/x" };
    });
    await useVault.getState().downloadEntry("id1", "a.txt");
    expect(busyWhileDialogOpen).toBe(false);
  });
});

describe("useVault: persistence", () => {
  it("partialize excludes session/engine/members (secrets/in-memory-only) and persists only workspaces + ownerUserId (all non-secret)", () => {
    const partialize = useVault.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");

    const knownWorkspaces: KnownWorkspace[] = [
      { id: "w1", name: "Docs", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" },
      { id: "w2", name: "Shared workspace", selfFounded: false, shared: true, globalWorkspaceId: "gw-1" },
    ];
    // Simulate a state object carrying secret-shaped fields (as if someone
    // accidentally added them to the store) to prove partialize is an
    // ALLOWLIST that drops them regardless - not a denylist that could miss one.
    const stateWithSecrets = {
      ...useVault.getState(),
      workspaces: knownWorkspaces,
      ownerUserId: "user_1",
      session: { kek: new Uint8Array(32), identity: {} },
      recoveryKeyOnce: "should-not-persist",
      members: [{ userId: "u1", email: "a@example.com", ed25519Pub: "ed-a", x25519Pub: "x-a" }],
    };

    const persisted = partialize!(stateWithSecrets) as Record<string, unknown>;

    expect(persisted).not.toHaveProperty("engine");
    expect(persisted).not.toHaveProperty("members");
    expect(persisted).not.toHaveProperty("recoveryKeyOnce");
    expect(persisted).not.toHaveProperty("status");
    expect(persisted).not.toHaveProperty("entries");
    expect(persisted).toEqual({ workspaces: knownWorkspaces, ownerUserId: "user_1" });
  });
});

// F8 (field report, Contract 6): the recovery key shown once at setup is
// actually usable, and a Vault whose passphrase AND key are both gone can be
// destroyed and set up again instead of being a permanent dead end.
describe("useVault: unlockWithRecoveryKey", () => {
  it("hands the NORMALISED key to the engine and unlocks", async () => {
    const seen: string[] = [];
    useVault.getState().__setEngine(makeFakeEngine({ unlockWithRecoveryKey: async (k) => { seen.push(k); } }));
    await useVault.getState().unlockWithRecoveryKey("ab12-cd34 ef56\n");
    // Whitespace and dashes are the paste's, not the key's (Contract 6).
    expect(seen).toEqual(["ab12cd34ef56"]);
    expect(useVault.getState().status).toBe("unlocked");
    expect(useVault.getState().hasIdentity).toBe(true);
  });

  it("failure stays locked with a generic message that never echoes the engine", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ unlockWithRecoveryKey: async () => { throw new Error("e2ee: unlock failed"); } }));
    await useVault.getState().unlockWithRecoveryKey("nope");
    expect(useVault.getState().status).toBe("locked");
    expect(useVault.getState().error).toBe("That recovery key did not unlock your Vault.");
    expect(useVault.getState().error).not.toContain("unlock failed");
  });
});

describe("useVault: destroyIdentity", () => {
  it("passes password and code to the engine, then returns the user to setup", async () => {
    const calls: [string, string | undefined][] = [];
    useVault.getState().__setEngine(makeFakeEngine({ destroyIdentity: async (pw, code) => { calls.push([pw, code]); } }));
    useVault.setState({ hasIdentity: true, status: "locked", workspaces: [{ id: "w", name: "S", selfFounded: true, shared: false, globalWorkspaceId: null }] });
    const ok = await useVault.getState().destroyIdentity("hunter22", "123456");
    expect(ok).toBe(true);
    expect(calls).toEqual([["hunter22", "123456"]]);
    expect(useVault.getState().hasIdentity).toBe(false);
    expect(useVault.getState().status).toBe("locked");
    // The Spaces list described keys that no longer exist.
    expect(useVault.getState().workspaces).toEqual([]);
    expect(useVault.getState().error).toBeNull();
  });

  // Fix round 1, MINOR (c): the API answers 400 {"error":"2fa_required"},
  // a CODE. Rendering it verbatim showed the user the literal string
  // "2fa_required"; the code is the contract, the sentence is presentation.
  it("turns the 2fa_required code into a sentence a person can act on", async () => {
    useVault.getState().__setEngine(makeFakeEngine({
      destroyIdentity: async () => { throw new ApiError("2fa_required", 400, { error: "2fa_required" }); },
    }));
    useVault.setState({ hasIdentity: true });
    const ok = await useVault.getState().destroyIdentity("hunter22");
    expect(ok).toBe(false);
    expect(useVault.getState().error).not.toContain("2fa_required");
    expect(useVault.getState().error).toMatch(/two-factor/i);
  });

  it("surfaces the server's refusal and keeps the identity", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ destroyIdentity: async () => { throw new Error("Incorrect password"); } }));
    useVault.setState({ hasIdentity: true });
    const ok = await useVault.getState().destroyIdentity("wrong");
    expect(ok).toBe(false);
    expect(useVault.getState().hasIdentity).toBe(true);
    expect(useVault.getState().error).toBe("Incorrect password");
  });
});

// Review Focus 3: a cancelled save dialog is not an error and not a success.
describe("useVault: downloadEntry outcomes", () => {
  it("stays quiet when the user cancels the save dialog", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ downloadFile: async () => new Uint8Array([1]) }));
    useVault.getState().__setSaver(async () => ({ ok: false, canceled: true }));
    await useVault.getState().downloadEntry("id1", "a.txt");
    expect(useVault.getState().busy).toBe(false);
    expect(useVault.getState().error).toBeNull();
  });

  it("reports a failed write as an error", async () => {
    useVault.getState().__setEngine(makeFakeEngine({ downloadFile: async () => new Uint8Array([1]) }));
    useVault.getState().__setSaver(async () => { throw new Error("EACCES: permission denied"); });
    await useVault.getState().downloadEntry("id1", "a.txt");
    expect(useVault.getState().busy).toBe(false);
    expect(useVault.getState().error).toMatch(/EACCES/);
  });
});

// Review Focus 4: one machine, two accounts.
describe("useVault: bindOwner", () => {
  const spaces: KnownWorkspace[] = [{ id: "w1", name: "Docs", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" }];

  it("keeps the Spaces list for the same account", () => {
    useVault.setState({ ownerUserId: "user_a", workspaces: spaces });
    useVault.getState().bindOwner("user_a");
    expect(useVault.getState().workspaces).toEqual(spaces);
  });

  it("adopts the list on first use (no owner yet)", () => {
    useVault.setState({ ownerUserId: null, workspaces: spaces });
    useVault.getState().bindOwner("user_a");
    expect(useVault.getState().ownerUserId).toBe("user_a");
    expect(useVault.getState().workspaces).toEqual(spaces);
  });

  it("drops another account's Spaces before anything else can read them", () => {
    useVault.setState({ ownerUserId: "user_a", workspaces: spaces, activeWorkspaceId: "w1", entries: [{ id: "e", name: "n", kind: "file" }], recoveryKeyOnce: "ab12", hasIdentity: true });
    useVault.getState().bindOwner("user_b");
    expect(useVault.getState().ownerUserId).toBe("user_b");
    expect(useVault.getState().workspaces).toEqual([]);
    expect(useVault.getState().activeWorkspaceId).toBeNull();
    expect(useVault.getState().entries).toEqual([]);
    expect(useVault.getState().recoveryKeyOnce).toBeNull();
    expect(useVault.getState().hasIdentity).toBeNull();
  });

  it("keeps a just-generated recovery key for the SAME account (lock must not destroy it)", () => {
    useVault.setState({ ownerUserId: "user_a", recoveryKeyOnce: "ab12" });
    useVault.getState().bindOwner("user_a");
    useVault.getState().lock();
    expect(useVault.getState().recoveryKeyOnce).toBe("ab12");
  });
});

describe("useVault: session reset", () => {
  it("locks when the renderer tears down the account session", async () => {
    let locked = 0;
    useVault.getState().__setEngine(makeFakeEngine({ lock: () => { locked++; } }));
    useVault.setState({ status: "unlocked", activeWorkspaceId: "w1", members: [{ userId: "u", email: "e", ed25519Pub: "p", x25519Pub: "x" }], recoveryKeyOnce: "ab12", hasIdentity: true });
    window.dispatchEvent(new Event(SESSION_RESET_EVENT));
    expect(locked).toBe(1);
    expect(useVault.getState().status).toBe("locked");
    expect(useVault.getState().activeWorkspaceId).toBeNull();
    expect(useVault.getState().members).toEqual([]);
    expect(useVault.getState().recoveryKeyOnce).toBeNull();
    expect(useVault.getState().hasIdentity).toBeNull();
  });
});

describe("useVault: createWorkspace scoping", () => {
  it("records the active global workspace as the new Space's scope", async () => {
    const scoped: [string, string][] = [];
    useVault.getState().__setEngine(makeFakeEngine({ setWorkspaceScope: async (w, g) => { scoped.push([w, g]); } }));
    setActiveGlobalWorkspaceId("gw-9");
    await useVault.getState().createWorkspace("Taxes");
    expect(scoped).toHaveLength(1);
    expect(scoped[0][1]).toBe("gw-9");
    expect(useVault.getState().workspaces[0]).toMatchObject({ name: "Taxes", selfFounded: true, shared: false, globalWorkspaceId: "gw-9" });
  });
});
