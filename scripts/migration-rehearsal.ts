import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatMigrationRehearsalReport,
  rehearseSchemaMigrations,
} from "../lib/ops/migration-rehearsal";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SNAPSHOT_RELATIVE = "tests/fixtures/cache-backup/valid.json";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let snapshotRelative = DEFAULT_SNAPSHOT_RELATIVE;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--snapshot") {
      const value = args[index + 1];
      if (!value) {
        console.error("--snapshot requires a repository-relative path");
        process.exit(2);
      }
      snapshotRelative = value;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  const snapshotPath = path.resolve(REPO_ROOT, snapshotRelative);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
  const report = await rehearseSchemaMigrations({ snapshot });
  console.log(json ? JSON.stringify(report, null, 2) : formatMigrationRehearsalReport(report));
  if (!report.ok) process.exit(1);
}

void main();
