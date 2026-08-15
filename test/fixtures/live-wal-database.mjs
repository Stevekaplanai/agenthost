#!/usr/bin/env bun
import { Database } from "bun:sqlite";

const databasePath = process.argv[2];
if (!databasePath) process.exit(2);

const database = new Database(databasePath, { create: true, strict: true });
database.run("PRAGMA journal_mode = WAL");
database.run("PRAGMA wal_autocheckpoint = 0");
database.run("CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");

const insert = database.prepare("INSERT INTO events (payload) VALUES (?)");
database.run("BEGIN IMMEDIATE");
try {
  insert.run("ordinary-row");
  insert.run("CUTOVER_TEST_PRIVATE_ROW");
  database.run("COMMIT");
} catch (error) {
  database.run("ROLLBACK");
  throw error;
}

process.stdout.write("READY\n");
process.stdin.resume();

const close = () => {
  try {
    database.close(false);
  } finally {
    process.exit(0);
  }
};
process.stdin.once("end", close);
process.once("SIGTERM", close);
