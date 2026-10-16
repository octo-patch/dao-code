import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function durableJson(file: string, value: unknown) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
    }
    catch (error) {
        try {
            unlinkSync(tmp);
        }
        catch { }
        throw error;
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
    const parent = openSync(path.dirname(file), "r");
    try {
        fsyncSync(parent);
    }
    finally {
        closeSync(parent);
    }
}
/** Text attachments use the same fsync + rename discipline as runner receipts. */
export function durableText(file: string, value: string) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, value);
        fsyncSync(fd);
    }
    catch (error) {
        try {
            unlinkSync(tmp);
        }
        catch { }
        throw error;
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
    const parent = openSync(path.dirname(file), "r");
    try {
        fsyncSync(parent);
    }
    finally {
        closeSync(parent);
    }
}
