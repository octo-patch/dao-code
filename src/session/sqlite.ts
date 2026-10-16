import { createRequire } from "node:module";
export interface SqlStatement {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}
export interface SqlDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): SqlStatement;
    close(): void;
}
/** Bun binaries use their built-in driver; npm/Node uses the installed native addon. */
export function openSqlite(file: string, readonly = false): SqlDatabase {
    const require = createRequire(import.meta.url);
    if (process.versions.bun) {
        const { Database } = require("bun:sqlite");
        return new Database(file, { readonly, create: !readonly, strict: true }) as SqlDatabase;
    }
    // Keep the Node-only addon external to Bun's standalone bundle.
    const driver = "better-sqlite3";
    const Database = require(driver);
    return new Database(file, { readonly, fileMustExist: readonly, timeout: 3000 }) as SqlDatabase;
}
export function transaction<T>(db: SqlDatabase, body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const value = body();
        db.exec("COMMIT");
        return value;
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* preserve original */ }
        throw error;
    }
}
