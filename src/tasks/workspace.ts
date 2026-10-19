import { lstat, readdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { taskError } from './quota.js';
/** Only server-created files under one private task work directory. No symlinks. */
export async function workspaceSize(root: string): Promise<number> {
    let total = 0, count = 0;
    async function visit(path: string, depth: number): Promise<void> {
        const st = await lstat(path);
        if (st.isSymbolicLink() || depth > 3 || ++count > 20000)
            throw taskError('STORAGE_IO');
        if (st.isFile())
            total += st.size;
        else if (st.isDirectory())
            for (const n of await readdir(path))
                await visit(join(path, n), depth + 1);
        else
            throw taskError('STORAGE_IO');
    }
    await visit(root, 0);
    return total;
}
export async function clearWorkspace(root: string) {
    await workspaceSize(root); // Verify the complete bounded target before recursive removal.
    for (const n of await readdir(root))
        await rm(join(root, n), { recursive: true, force: true });
}
export function localStopped(pid: number | null, host: string | null, currentHost: string) {
    if (!pid)
        return true;
    if (host !== currentHost)
        return false;
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
}
export async function groupStopped(pid: number | null, host: string | null, currentHost: string) {
    if (!pid)
        return true;
    if (host !== currentHost)
        return false;
    if (process.platform !== 'linux')
        return localStopped(pid, host, currentHost);
    for (const id of await readdir('/proc')) {
        if (!/^\d+$/.test(id))
            continue;
        try {
            const s = await readFile('/proc/' + id + '/stat', 'utf8'), fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
            if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0]!))
                return false;
        }
        catch (e) {
            if ((e as any)?.code !== 'ENOENT' && (e as any)?.code !== 'ESRCH')
                throw e;
        }
    }
    return true;
}
export async function processIdentity(pid: number): Promise<string | null> {
    if (process.platform !== 'linux')
        return null;
    try {
        const s = await readFile('/proc/' + pid + '/stat', 'utf8'), fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() + ':' + fields[19];
    }
    catch (e) {
        if ((e as any)?.code === 'ENOENT' || (e as any)?.code === 'ESRCH')
            return null;
        throw e;
    }
}
