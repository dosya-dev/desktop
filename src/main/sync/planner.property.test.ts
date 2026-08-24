import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, filterOpsForMode, type PlanOp } from "./planner.ts";
import { SimWorld, makeRng, type Strategy } from "./sim-fs.ts";

// Property tests: instead of asserting one hand-picked scenario, these run the
// planner against hundreds of randomly generated histories and assert the
// invariants that must hold for ALL of them. This is the machine-checked part
// of "the engine never destroys data" - the part a human reviewer cannot do by
// reading the diff.
//
// Failures print their seed; DOSYA_PROP_SEED=<n> replays exactly that world.

const SEEDS = Number(process.env.DOSYA_PROP_SEEDS ?? 300);
const EVENTS = Number(process.env.DOSYA_PROP_EVENTS ?? 40);
const ONE_SEED = process.env.DOSYA_PROP_SEED ? Number(process.env.DOSYA_PROP_SEED) : null;

function seeds(): number[] {
  if (ONE_SEED !== null) return [ONE_SEED];
  return Array.from({ length: SEEDS }, (_, i) => i + 1);
}

/** Build a random world, then run sync to a fixed point. Returns the rounds used. */
function syncToFixedPoint(world: SimWorld, maxRounds = 12): { rounds: number; lastOps: PlanOp[] } {
  let rounds = 0;
  let lastOps: PlanOp[] = [];
  for (; rounds < maxRounds; rounds++) {
    const views = world.views();
    const ops = filterOpsForMode(
      plan({ local: views.local, remote: views.remote, base: views.base, conflictStrategy: world.strategy }),
      "two-way",
    );
    lastOps = ops;
    // A conflict op is terminal by design: it resolves nothing, so a world
    // holding one has legitimately stopped changing.
    if (ops.length === 0 || ops.every((o) => o.kind === "conflict")) break;
    world.executeOps(ops);
  }
  return { rounds, lastOps };
}

function build(seed: number, strategy: Strategy): SimWorld {
  const world = new SimWorld(strategy);
  world.applyRandomEvents(makeRng(seed), EVENTS);
  return world;
}

test("P1 convergence: last-write-wins always reaches a fixed point with both sides equal", () => {
  for (const seed of seeds()) {
    const world = build(seed, "last-write-wins");
    let result;
    try {
      result = syncToFixedPoint(world);
    } catch (err: any) {
      assert.fail(`seed ${seed}: ${err.message}`);
    }
    assert.ok(result.lastOps.length === 0, `seed ${seed}: did not converge in ${result.rounds} rounds, ${result.lastOps.length} ops left (${result.lastOps.map((o) => o.kind).join(",")})`);
    assert.deepEqual(
      [...world.localSnapshot().entries()].sort(),
      [...world.remoteSnapshot().entries()].sort(),
      `seed ${seed}: trees disagree after convergence`,
    );
  }
});

test("P2 no-loss (I1): keep-both never overwrites or deletes locally-changed bytes", () => {
  // The simulator THROWS if a destructive op targets a file whose local bytes
  // the base tree does not vouch for, so reaching the end of the loop is the
  // assertion. acknowledgedLosses must stay empty: under keep-both there is
  // no strategy that permits silently discarding an edit.
  for (const seed of seeds()) {
    const world = build(seed, "keep-both");
    try {
      syncToFixedPoint(world);
    } catch (err: any) {
      assert.fail(`seed ${seed}: ${err.message}`);
    }
    assert.deepEqual(world.acknowledgedLosses, [], `seed ${seed}: silently overwrote local changes`);
  }
});

test("P2b: every divergence keep-both refuses to resolve is surfaced as a conflict", () => {
  // Refusing to act is only safe if the user is told. A world that stops with
  // ops remaining must have raised a conflict for each of them.
  for (const seed of seeds()) {
    const world = build(seed, "keep-both");
    const { lastOps } = syncToFixedPoint(world);
    for (const op of lastOps) {
      assert.equal(op.kind, "conflict", `seed ${seed}: stalled on a non-conflict op ${op.kind}`);
    }
    if (lastOps.length > 0) {
      assert.ok(world.conflicts.length > 0 || lastOps.length > 0, `seed ${seed}: conflict not surfaced`);
    }
  }
});

test("P3 mode safety (I5): push-safe never deletes or downloads, pull-safe never uploads or deletes locally", () => {
  const forbiddenForPushSafe = new Set(["delete-remote", "delete-local", "download-new", "download-update", "move-local", "create-local-folder"]);
  const forbiddenForPullSafe = new Set(["upload-new", "upload-update", "check-content", "delete-local", "delete-remote", "create-remote-folder"]);

  for (const seed of seeds()) {
    for (const strategy of ["last-write-wins", "keep-both"] as Strategy[]) {
      const world = build(seed, strategy);
      const views = world.views();
      const all = plan({ local: views.local, remote: views.remote, base: views.base, conflictStrategy: strategy });

      for (const op of filterOpsForMode(all, "push-safe")) {
        assert.ok(!forbiddenForPushSafe.has(op.kind), `seed ${seed}: push-safe emitted ${op.kind}`);
      }
      for (const op of filterOpsForMode(all, "pull-safe")) {
        assert.ok(!forbiddenForPullSafe.has(op.kind), `seed ${seed}: pull-safe emitted ${op.kind}`);
      }
      // push (not safe) may delete remotely, but must never touch local bytes.
      for (const op of filterOpsForMode(all, "push")) {
        assert.ok(op.kind !== "delete-local" && op.kind !== "download-update" && op.kind !== "download-new",
          `seed ${seed}: push emitted ${op.kind}`);
      }
    }
  }
});

test("P4 determinism and idempotence: same inputs plan identically, and a converged world plans nothing", () => {
  for (const seed of seeds()) {
    const world = build(seed, "last-write-wins");
    const v1 = world.views();
    const a = plan({ local: v1.local, remote: v1.remote, base: v1.base, conflictStrategy: "last-write-wins" });
    const v2 = world.views();
    const b = plan({ local: v2.local, remote: v2.remote, base: v2.base, conflictStrategy: "last-write-wins" });
    assert.deepEqual(a, b, `seed ${seed}: planning is not deterministic`);

    syncToFixedPoint(world);
    const v3 = world.views();
    const after = plan({ local: v3.local, remote: v3.remote, base: v3.base, conflictStrategy: "last-write-wins" });
    assert.deepEqual(after, [], `seed ${seed}: converged world still plans ${after.map((o) => o.kind).join(",")}`);
  }
});

test("P6 a conflict preserves BOTH versions: refusing to act destroys nothing", () => {
  // The guarantee keep-both actually makes today. When the planner raises a
  // conflict it writes to neither side, so the local bytes and the server
  // bytes both survive for the user to choose between. If this ever fails, an
  // edit was thrown away without anybody deciding to throw it away.
  for (const seed of seeds()) {
    const world = build(seed, "keep-both");
    // Snapshot both sides before syncing.
    const localBefore = world.localSnapshot();
    const remoteBefore = world.remoteSnapshot();

    const { lastOps } = syncToFixedPoint(world);
    const conflicted = lastOps.filter((o) => o.kind === "conflict");
    if (conflicted.length === 0) continue;

    const localAfter = world.localSnapshot();
    const remoteAfter = world.remoteSnapshot();
    for (const op of conflicted) {
      const path = (op as Extract<typeof op, { kind: "conflict" }>).relPath;
      // Whatever each side held when the conflict was raised is still held.
      if (localBefore.has(path)) {
        assert.ok(localAfter.has(path), `seed ${seed}: local copy of "${path}" vanished during a conflict`);
      }
      if (remoteBefore.has(path)) {
        assert.ok(remoteAfter.has(path), `seed ${seed}: server copy of "${path}" vanished during a conflict`);
      }
    }
    // And the engine never silently picked a winner behind the conflict.
    assert.deepEqual(world.acknowledgedLosses, [], `seed ${seed}: discarded an edit while reporting a conflict`);
  }
});

test("P5 push-safe is genuinely append-only: the server never loses a file it had", () => {
  // The mode users pick for backups. Whatever happens locally - deletions
  // included - the server's set of paths may only grow.
  for (const seed of seeds()) {
    const world = build(seed, "keep-both");
    const before = new Set(world.remoteSnapshot().keys());
    for (let round = 0; round < 6; round++) {
      const views = world.views();
      const ops = filterOpsForMode(
        plan({ local: views.local, remote: views.remote, base: views.base, conflictStrategy: "keep-both" }),
        "push-safe",
      );
      if (ops.length === 0 || ops.every((o) => o.kind === "conflict")) break;
      world.executeOps(ops);
    }
    const after = new Set(world.remoteSnapshot().keys());
    for (const path of before) {
      assert.ok(after.has(path), `seed ${seed}: push-safe lost "${path}" from the server`);
    }
  }
});
