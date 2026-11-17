import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, readlink, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorCode, errorMessage } from "../core/guards.js";
/** The codes Windows refuses a folder's rename with while a program runs inside it or holds a file in it open. */
const HELD_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** How long `lsof` may take to list every program's working folder. */
const LSOF_TIMEOUT_MS = 10_000;
/** A folder's listing; undefined when the folder does not exist. */
async function listing(dir) {
    try {
        return await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
function kindOfStats(stats) {
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'folder' : 'other';
}
/** The real filesystem through Node, which reads a Windows junction as a link as it does a symlink. */
export const NODE_WORKTREE_FILES = {
    async entries(dir) {
        const entries = [];
        for (const dirent of (await listing(dir)) ?? []) {
            // Windows marks every reparse point a link in a folder listing, a cloud placeholder too; lstat tells a
            // real link (a symlink or a junction) from a folder that only carries one.
            const kind = dirent.isSymbolicLink() ? kindOfStats(await lstat(resolve(dir, dirent.name))) : kindOfStats(dirent);
            entries.push({ name: dirent.name, kind });
        }
        return entries;
    },
    async kindOf(path) {
        try {
            return kindOfStats(await lstat(path));
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT') {
                return 'missing';
            }
            throw error;
        }
    },
    async linkTarget(path) {
        return resolve(dirname(path), await readlink(path));
    },
    async entryCount(path) {
        try {
            return (await readdir(path)).length;
        }
        catch (error) {
            const code = errorCode(error);
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                return undefined;
            }
            throw error;
        }
    },
    async unlinkLink(path) {
        // unlink, never rm or rmdir: it removes a symlink or a junction itself and fails on a real folder.
        await unlink(path);
    },
    async makeLink(path, target) {
        // A junction on Windows, which needs no privilege; elsewhere Node ignores the type and makes a symlink.
        await symlink(target, path, 'junction');
    },
    async removeEmptyFolder(path) {
        // rmdir with no recursive option: it fails on a folder that holds anything, so nothing in it can be lost.
        await rmdir(path);
    },
    async canonical(path) {
        try {
            return realpathSync.native(path);
        }
        catch {
            return undefined;
        }
    },
    async workingFolders() {
        if (process.platform === 'linux') {
            return await procWorkingFolders();
        }
        if (process.platform === 'darwin') {
            return await lsofWorkingFolders();
        }
        return { kind: 'unknown', reason: `${process.platform === 'win32' ? 'Windows' : process.platform} gives no plain way to read another program's working folder` };
    },
    async moveProbe(folder) {
        if (process.platform !== 'win32') {
            return { kind: 'not-needed' };
        }
        return await renameProbe(folder, `${folder}.teamrig-check-${randomUUID().slice(0, 8)}`);
    },
};
/**
 * Renames `folder` to `aside`, a sibling no one uses, and straight back with `move` (#797): Windows refuses the first
 * rename exactly when a program runs inside the folder or holds a file in it open, which is what makes `git worktree
 * remove` stop partway there. Nothing else is touched; a failed rename back is reported, never retried elsewhere.
 */
export async function renameProbe(folder, aside, move = rename) {
    try {
        await move(folder, aside);
    }
    catch (error) {
        const code = errorCode(error);
        if (code !== undefined && HELD_CODES.has(code)) {
            return { kind: 'held', code };
        }
        return { kind: 'unknown', reason: `${folder} could not be renamed to check (${errorMessage(error)})` };
    }
    try {
        await move(aside, folder);
    }
    catch (error) {
        return { kind: 'stuck', moved: aside, reason: errorMessage(error) };
    }
    return { kind: 'movable' };
}
/** Linux: each `/proc/<pid>/cwd` link this user may read; a program that ended, or another user's, is skipped. */
async function procWorkingFolders() {
    let pids;
    try {
        pids = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
    }
    catch (error) {
        return { kind: 'unknown', reason: `/proc cannot be read (${errorMessage(error)})` };
    }
    const programs = [];
    for (const id of pids) {
        const pid = Number(id);
        if (pid === process.pid) {
            continue;
        }
        try {
            const folder = await readlink(`/proc/${id}/cwd`);
            programs.push({ pid, name: (await readFile(`/proc/${id}/comm`, 'utf8')).trim(), folder });
        }
        catch {
            // Ended since the listing, or another user's: neither is read.
        }
    }
    return { kind: 'read', programs };
}
/** macOS: `lsof -d cwd`, whose exit is 1 when it could not read some program, though it lists the rest. */
async function lsofWorkingFolders() {
    return await new Promise((settle) => {
        execFile('lsof', ['-n', '-P', '-d', 'cwd', '-F', 'pcn'], { timeout: LSOF_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
            const programs = parseLsofFolders(stdout, process.pid);
            settle(error !== null && programs.length === 0 ? { kind: 'unknown', reason: `lsof did not list them (${errorMessage(error)})` } : { kind: 'read', programs });
        });
    });
}
/** `lsof -F pcn` output: a `p<pid>` line opens each program, then its `c<name>`, and `n<folder>` for its cwd; `self` is left out. */
export function parseLsofFolders(text, self) {
    const programs = [];
    let pid;
    let name = '';
    for (const line of text.split('\n')) {
        const field = line.slice(1);
        if (line.startsWith('p')) {
            pid = Number(field);
            name = '';
        }
        else if (line.startsWith('c')) {
            name = field;
        }
        else if (line.startsWith('n') && pid !== undefined && Number.isInteger(pid) && pid !== self) {
            programs.push({ pid, name, folder: field });
        }
    }
    return programs;
}
