import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { openSqlite, transaction } from "../src/session/sqlite.js";
const dir = mkdtempSync(path.join(tmpdir(), "dao-sqlite-"));
try {
    let db = openSqlite(path.join(dir, "test.db"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE t (id TEXT PRIMARY KEY)");
    assert.equal((db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
    }).journal_mode, "wal");
    assert.equal((db.prepare("PRAGMA synchronous").get() as {
        synchronous: number;
    }).synchronous, 2);
    transaction(db, () => { db.prepare("INSERT INTO t VALUES (?)").run("committed"); });
    assert.throws(() => transaction(db, () => { db.prepare("INSERT INTO t VALUES (?)").run("rolled-back"); throw new Error("fault"); }));
    db.close();
    db = openSqlite(path.join(dir, "test.db"));
    assert.deepEqual(db.prepare("SELECT * FROM t").all(), [{ id: "committed" }]);
    console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), passed: true }));
    db.close();
}
finally {
    rmSync(dir, { recursive: true, force: true });
}
