import { createHash } from "node:crypto";

import { checksumMigration } from "../migrations/checksum";
import { MemoryMigrationStore } from "../migrations/memory-store";
import { MIGRATIONS } from "../migrations/registry";
import { getStatus, migrateDown, migrateUp } from "../migrations/runner";
import type {
  AppliedMigration,
  Migration,
  MigrationStatement,
  MigrationStore,
} from "../migrations/types";
import {
  backupFingerprint,
  formatCacheBackupReport,
  parseBackup,
  verifyCacheBackup,
} from "./cache-backup";

export const MIGRATION_REHEARSAL_SCHEMA_VERSION = 1 as const;
export const MIGRATION_REHEARSAL_KIND = "mimir-schema-migration-rehearsal" as const;

export type MigrationRehearsalDirection = "up" | "down" | "reapply";

export type MigrationRehearsalFindingCode =
  | "SNAPSHOT_INVALID"
  | "REGISTRY_INVALID"
  | "CHECKSUM_MISMATCH"
  | "UP_FAILED"
  | "DOWN_FAILED"
  | "REAPPLY_FAILED"
  | "ROUND_TRIP_FINGERPRINT_MISMATCH";

export interface MigrationRehearsalFinding {
  code: MigrationRehearsalFindingCode;
  message: string;
}

export interface MigrationRehearsalStep {
  migrationId: string;
  version: number;
  status: string;
  error: string | null;
}

export interface MigrationRehearsalPhase {
  direction: MigrationRehearsalDirection;
  ran: boolean;
  ok: boolean;
  steps: readonly MigrationRehearsalStep[];
  appliedVersions: readonly number[];
  statementFingerprint: string;
  stateFingerprint: string;
}

export interface MigrationRehearsalReport {
  ok: boolean;
  schemaVersion: typeof MIGRATION_REHEARSAL_SCHEMA_VERSION;
  kind: typeof MIGRATION_REHEARSAL_KIND;
  snapshotFingerprint: string;
  migrationFingerprint: string;
  phases: Record<MigrationRehearsalDirection, MigrationRehearsalPhase>;
  roundTripOk: boolean;
  findings: readonly MigrationRehearsalFinding[];
  summary: {
    snapshotVerified: boolean;
    registeredMigrations: number;
    upVersions: readonly number[];
    downVersions: readonly number[];
    reappliedVersions: readonly number[];
  };
}

export interface RehearsalMigrationStore extends MigrationStore {
  readonly executed: readonly MigrationStatement[];
  listTables(): string[];
}

export interface RehearseSchemaMigrationsOptions {
  snapshot: unknown;
  migrations?: readonly Migration[];
  nowMs?: () => number;
  createStore?: () => RehearsalMigrationStore;
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalStatement(statement: MigrationStatement): string {
  return canonicalJson([
    statement.sql.replace(/\s+/g, " ").trim(),
    statement.args ?? [],
  ]);
}

function skippedPhase(direction: MigrationRehearsalDirection): MigrationRehearsalPhase {
  return {
    direction,
    ran: false,
    ok: false,
    steps: [],
    appliedVersions: [],
    statementFingerprint: "",
    stateFingerprint: "",
  };
}

async function stateFingerprint(store: RehearsalMigrationStore): Promise<string> {
  const applied = (await store.listApplied()).map((row: AppliedMigration) => ({
    migrationId: row.migrationId,
    schemaVersion: row.schemaVersion,
    checksum: row.checksum,
  }));
  applied.sort((left, right) => left.schemaVersion - right.schemaVersion);
  return fingerprint({
    applied,
    tables: [...store.listTables()].sort(),
  });
}

function buildingFailure(message: string): MigrationRehearsalFinding[] {
  return [{ code: "SNAPSHOT_INVALID", message }];
}

export async function rehearseSchemaMigrations(
  options: RehearseSchemaMigrationsOptions,
): Promise<MigrationRehearsalReport> {
  const migrations = [...(options.migrations ?? MIGRATIONS)];
  const migrationFingerprint = fingerprint(
    migrations.map((migration) => ({
      id: migration.id,
      version: migration.version,
      checksum: checksumMigration(migration),
      irreversible: migration.irreversible ?? false,
      up: migration.up.map(canonicalStatement),
      down: migration.down.map(canonicalStatement),
    })),
  );
  const phases: MigrationRehearsalReport["phases"] = {
    up: skippedPhase("up"),
    down: skippedPhase("down"),
    reapply: skippedPhase("reapply"),
  };
  const baseReport = (
    snapshotFingerprint: string,
    findings: readonly MigrationRehearsalFinding[],
    snapshotVerified: boolean,
  ): MigrationRehearsalReport => ({
    ok: false,
    schemaVersion: MIGRATION_REHEARSAL_SCHEMA_VERSION,
    kind: MIGRATION_REHEARSAL_KIND,
    snapshotFingerprint,
    migrationFingerprint,
    phases,
    roundTripOk: false,
    findings,
    summary: {
      snapshotVerified,
      registeredMigrations: migrations.length,
      upVersions: phases.up.appliedVersions,
      downVersions: phases.down.appliedVersions,
      reappliedVersions: phases.reapply.appliedVersions,
    },
  });

  let backup;
  try {
    backup = parseBackup(options.snapshot);
  } catch (error) {
    return baseReport(
      "",
      buildingFailure(error instanceof Error ? error.message : "invalid read-index snapshot"),
      false,
    );
  }

  const snapshotFingerprint = backupFingerprint(backup);
  const findings: MigrationRehearsalFinding[] = [];
  const backupReport = verifyCacheBackup(backup);
  if (!backupReport.ok) {
    findings.push({
      code: "SNAPSHOT_INVALID",
      message: formatCacheBackupReport(backupReport),
    });
    return baseReport(snapshotFingerprint, findings, false);
  }

  const store = (options.createStore ?? (() => new MemoryMigrationStore()))();
  const nowMs = options.nowMs ?? (() => 0);
  const initialStatus = await getStatus(store, { migrations, nowMs });
  if (!initialStatus.checksumsOk) {
    findings.push({
      code: "CHECKSUM_MISMATCH",
      message: initialStatus.issues.join("; ") || "applied migration checksum mismatch",
    });
  }
  for (const issue of initialStatus.issues) {
    findings.push({ code: "REGISTRY_INVALID", message: issue });
  }
  if (findings.length > 0) {
    return baseReport(snapshotFingerprint, findings, true);
  }

  const upStart = store.executed.length;
  let upResult;
  try {
    upResult = await migrateUp(store, { migrations, nowMs });
  } catch (error) {
    findings.push({
      code: "UP_FAILED",
      message: error instanceof Error ? error.message : "migrateUp failed",
    });
    return baseReport(snapshotFingerprint, findings, true);
  }
  phases.up = {
    direction: "up",
    ran: true,
    ok: upResult.ok,
    steps: upResult.steps.map((step) => ({
      migrationId: step.migrationId,
      version: step.version,
      status: step.status,
      error: step.error ?? null,
    })),
    appliedVersions: [...upResult.appliedVersions],
    statementFingerprint: fingerprint(store.executed.slice(upStart).map(canonicalStatement)),
    stateFingerprint: await stateFingerprint(store),
  };
  if (!upResult.ok) {
    findings.push({ code: "UP_FAILED", message: upResult.summary });
    return baseReport(snapshotFingerprint, findings, true);
  }

  const downStart = store.executed.length;
  let downResult;
  try {
    downResult = await migrateDown(store, { migrations, nowMs });
  } catch (error) {
    findings.push({
      code: "DOWN_FAILED",
      message: error instanceof Error ? error.message : "migrateDown failed",
    });
    return baseReport(snapshotFingerprint, findings, true);
  }
  phases.down = {
    direction: "down",
    ran: true,
    ok: downResult.ok,
    steps: downResult.steps.map((step) => ({
      migrationId: step.migrationId,
      version: step.version,
      status: step.status,
      error: step.error ?? null,
    })),
    appliedVersions: [...downResult.appliedVersions],
    statementFingerprint: fingerprint(store.executed.slice(downStart).map(canonicalStatement)),
    stateFingerprint: await stateFingerprint(store),
  };
  if (!downResult.ok) {
    findings.push({ code: "DOWN_FAILED", message: downResult.summary });
    return baseReport(snapshotFingerprint, findings, true);
  }

  const reapplyStart = store.executed.length;
  let reapplyResult;
  try {
    reapplyResult = await migrateUp(store, { migrations, nowMs });
  } catch (error) {
    findings.push({
      code: "REAPPLY_FAILED",
      message: error instanceof Error ? error.message : "migrateUp reapply failed",
    });
    return baseReport(snapshotFingerprint, findings, true);
  }
  phases.reapply = {
    direction: "reapply",
    ran: true,
    ok: reapplyResult.ok,
    steps: reapplyResult.steps.map((step) => ({
      migrationId: step.migrationId,
      version: step.version,
      status: step.status,
      error: step.error ?? null,
    })),
    appliedVersions: [...reapplyResult.appliedVersions],
    statementFingerprint: fingerprint(store.executed.slice(reapplyStart).map(canonicalStatement)),
    stateFingerprint: await stateFingerprint(store),
  };
  if (!reapplyResult.ok) {
    findings.push({ code: "REAPPLY_FAILED", message: reapplyResult.summary });
    return baseReport(snapshotFingerprint, findings, true);
  }

  const roundTripOk =
    phases.up.stateFingerprint === phases.reapply.stateFingerprint &&
    phases.up.appliedVersions.join(",") === phases.reapply.appliedVersions.join(",");
  if (!roundTripOk) {
    findings.push({
      code: "ROUND_TRIP_FINGERPRINT_MISMATCH",
      message: "state after down/up reapply does not match the initial up migration",
    });
  }

  return {
    ok: findings.length === 0 && roundTripOk,
    schemaVersion: MIGRATION_REHEARSAL_SCHEMA_VERSION,
    kind: MIGRATION_REHEARSAL_KIND,
    snapshotFingerprint,
    migrationFingerprint,
    phases,
    roundTripOk,
    findings,
    summary: {
      snapshotVerified: true,
      registeredMigrations: migrations.length,
      upVersions: phases.up.appliedVersions,
      downVersions: phases.down.appliedVersions,
      reappliedVersions: phases.reapply.appliedVersions,
    },
  };
}

export function formatMigrationRehearsalReport(report: MigrationRehearsalReport): string {
  const lines = [
    `schema migration rehearsal: ${report.ok ? "PASS" : "FAILED"}`,
    `snapshot fingerprint: ${report.snapshotFingerprint || "unavailable"}`,
    `migration fingerprint: ${report.migrationFingerprint}`,
    `registered migrations: ${report.summary.registeredMigrations}`,
  ];
  for (const phase of [report.phases.up, report.phases.down, report.phases.reapply]) {
    const status = phase.ran ? (phase.ok ? "PASS" : "FAILED") : "NOT RUN";
    lines.push(
      `${phase.direction}: ${status} (${phase.steps.length} step(s), ${phase.appliedVersions.length} applied)`,
    );
    if (phase.ran) {
      lines.push(`  statement fingerprint: ${phase.statementFingerprint}`);
      lines.push(`  state fingerprint: ${phase.stateFingerprint}`);
    }
  }
  lines.push(`round-trip fingerprint match: ${report.roundTripOk ? "yes" : "no"}`);
  for (const finding of report.findings) {
    lines.push(`  [${finding.code}] ${finding.message}`);
  }
  return lines.join("\n");
}
