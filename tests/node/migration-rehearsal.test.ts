import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { checksumMigration } from "../../lib/migrations/checksum";
import { MemoryMigrationStore } from "../../lib/migrations/memory-store";
import { MIGRATIONS } from "../../lib/migrations/registry";
import type { Migration } from "../../lib/migrations/types";
import {
  formatMigrationRehearsalReport,
  rehearseSchemaMigrations,
} from "../../lib/ops/migration-rehearsal";

const SNAPSHOT = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "cache-backup", "valid.json"),
    "utf8",
  ),
) as unknown;

test("positive: a synthetic snapshot rehearses up, down, and reapply with matching fingerprints", async () => {
  const report = await rehearseSchemaMigrations({ snapshot: SNAPSHOT });

  assert.equal(report.ok, true, formatMigrationRehearsalReport(report));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "mimir-schema-migration-rehearsal");
  assert.match(report.snapshotFingerprint, /^[0-9a-f]{64}$/);
  assert.match(report.migrationFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.summary.upVersions, [1, 2, 3]);
  assert.deepEqual(report.summary.downVersions, [1, 2]);
  assert.deepEqual(report.summary.reappliedVersions, [1, 2, 3]);
  assert.equal(report.phases.up.ran, true);
  assert.equal(report.phases.down.ran, true);
  assert.equal(report.phases.reapply.ran, true);
  assert.equal(report.phases.up.stateFingerprint, report.phases.reapply.stateFingerprint);
  assert.notEqual(report.phases.up.stateFingerprint, report.phases.down.stateFingerprint);
  assert.equal(report.roundTripOk, true);
});

test("positive: rehearsal reports are deterministic and contain no raw snapshot data", async () => {
  const first = await rehearseSchemaMigrations({ snapshot: SNAPSHOT });
  const second = await rehearseSchemaMigrations({ snapshot: SNAPSHOT });

  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("CAQPTFHY5VXSWR3CNRGFVLGDNEH4NCOE2PCZL4QZ4JQMWVD54GRCMQPX"), false);
  assert.equal(serialized.includes("GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE"), false);
});

test("negative: a synthetically corrupted snapshot fails closed before migrating", async () => {
  const snapshot = {
    ...(SNAPSHOT as Record<string, unknown>),
    checksum: "0".repeat(64),
  };
  const report = await rehearseSchemaMigrations({ snapshot });

  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "SNAPSHOT_INVALID"));
  assert.equal(report.phases.up.ran, false);
  assert.equal(report.phases.down.ran, false);
  assert.equal(report.phases.reapply.ran, false);
  assert.equal(report.summary.snapshotVerified, false);
});

test("negative: an applied migration checksum mismatch fails before migrating", async () => {
  const migration = MIGRATIONS.find((item) => item.version === 3)!;
  const store = new MemoryMigrationStore({
    seedApplied: [
      {
        migrationId: migration.id,
        schemaVersion: migration.version,
        checksum: `bad-${checksumMigration(migration)}`,
        appliedAt: 0,
      },
    ],
  });
  const report = await rehearseSchemaMigrations({
    snapshot: SNAPSHOT,
    createStore: () => store,
  });

  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "CHECKSUM_MISMATCH"));
  assert.equal(report.phases.up.ran, false);
});

test("failure: a transaction failure is reported as an up failure without continuing", async () => {
  const report = await rehearseSchemaMigrations({
    snapshot: SNAPSHOT,
    createStore: () => new MemoryMigrationStore({ failNextTransaction: true }),
  });

  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "UP_FAILED"));
  assert.equal(report.phases.up.ok, false);
  assert.equal(report.phases.down.ran, false);
  assert.equal(report.phases.reapply.ran, false);
  assert.equal(report.roundTripOk, false);
});

test("failure: an irreversible-only registry reports a down failure", async () => {
  const migrations: Migration[] = [
    {
      id: "001_baseline_only",
      version: 1,
      description: "irreversible baseline fixture",
      up: [{ sql: "CREATE TABLE IF NOT EXISTS fixture_alpha (id TEXT PRIMARY KEY)" }],
      down: [],
      irreversible: true,
      irreversibleReason: "fixture baseline is intentionally irreversible",
    },
  ];
  const report = await rehearseSchemaMigrations({ snapshot: SNAPSHOT, migrations });

  assert.equal(report.ok, false);
  assert.equal(report.phases.up.ok, true);
  assert.ok(report.findings.some((finding) => finding.code === "DOWN_FAILED"));
  assert.equal(report.phases.reapply.ran, false);
});
