#!/usr/bin/env node
// #3103: per-machine test-suite mutex + fail-fast.
//
// Two full `npm test` runs on one machine corrupt each other: node --test
// defaults to cores-1 concurrency, so two runs ≈ 2x the spawn/attach load and
// every 15s readiness watchdog times out (mass false-red), while daemons that
// don't get a per-test XDG_STATE_HOME share the machine-global
// ~/.local/state/billion-context (port-zone drift, multi-instance alarms). The
// suite had ZERO detection of a sibling run — the second one silently degraded
// into false-red instead of failing fast (#3103; violates §7.2 "tests must be
// deterministic"). This is the suite-level counterpart of #2106 (intra-suite
// fixed-path cacheDir contention).
//
// Mechanism reuses the cross-process update-lock from src/update.ts (#117/#991):
// an O_EXCL ("wx") lock file holding { pid, ts, cmdline, cwd }, liveness via
// kill(pid, 0), steal-on-dead. NO age timeout — a live suite is never stolen no
// matter how long it runs (a local full run can exceed any fixed budget); the
// rare pid-reuse ghost is covered by the BILI_TEST_FORCE=1 escape hatch, which
// the fail-fast line names explicitly.
//
// Two modes (argv[2]):
//   gate  NON-owning fast check, prepended to the `pretest` npm hook so a second
//         `npm test` refuses within milliseconds (BEFORE the kernel/pi build)
//         instead of spending a build cycle and then colliding. Exits 1 with a
//         holder line only when a LIVE holder exists; exits 0 for no-lock or a
//         dead (stealable) holder. Creates/holds nothing.
//   run   OWNING wrapper that REPLACES the old `test` body. Acquires the lock,
//         spawns the real `node --import … --test …` suite, streams stdio, and
//         releases the lock in finally regardless of outcome. A SIGKILLed
//         wrapper leaves a dead-pid lock that the next run steals (self-heal);
//         orphan daemons left by a killed suite do NOT hold the lock (known
//         limitation — surfaced in the fail-fast hint).
//
// Lock path mirrors src/paths.ts cacheDir() ($XDG_CACHE_HOME/billion-context/,
// default ~/.cache/billion-context/) — resolved inline here because this runs
// under plain node (no tsx, no src import).

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** $XDG_CACHE_HOME/billion-context/test-suite.lock — mirrors paths.ts cacheDir(). */
export function resolveLockPath(env = process.env) {
    const xdg = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
        ? path.resolve(env.XDG_CACHE_HOME)
        : path.join(homedir(), ".cache");
    return path.join(xdg, "billion-context", "test-suite.lock");
}

/** Parse the lock file → { pid, ts, cmdline?, cwd? } or null (absent/corrupt). */
export async function readLock(lockPath) {
    try {
        const data = JSON.parse(await readFile(lockPath, "utf-8"));
        if (typeof data?.pid === "number" && typeof data?.ts === "number") return data;
    } catch {
        // absent or corrupt — treat as no lock
    }
    return null;
}

/** Liveness probe: kill(pid, 0) sends no signal, just checks existence (#117). */
export function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** BILI_TEST_FORCE=1 (or true/yes) bypasses the lock entirely — documented in
 *  reference/env-vars.md as a per-process test-infra escape hatch. */
export function forceEnabled(env = process.env) {
    const v = String(env.BILI_TEST_FORCE ?? "").trim().toLowerCase();
    return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/** Human age string for the fail-fast line ("42s ago", "3m 05s ago", "1h 04m ago"). */
export function formatAge(msAgo) {
    const s = Math.max(0, Math.round(msAgo / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

const CMDLINE_CAP = 120;
function shortCmdline(cmdline) {
    const c = (cmdline ?? "").trim();
    return c.length > CMDLINE_CAP ? `${c.slice(0, CMDLINE_CAP - 1)}…` : c;
}

/** The fail-fast banner (stderr). Names pid + how long + command, per #3103. */
export function blockedMessage(holder, lockPath, now = Date.now()) {
    const lines = [
        "✋ Another billion-context test suite is already running on this machine.",
        `   holder:  pid=${holder.pid} · started ${formatAge(now - holder.ts)} ago`,
        `   command: ${shortCmdline(holder.cmdline)}`,
        `   lock:    ${lockPath}`,
        "   Override anyway: BILI_TEST_FORCE=1 npm test",
        "   Note: a killed suite's orphan daemons/fake-upstreams do NOT hold this lock",
        "   and may still occupy ports — check with ps/ss before overriding.",
    ];
    return lines.join("\n");
}

/**
 * Try to acquire the lock. Returns { acquired, holder }:
 *  - free path            → { acquired: true, holder: null }
 *  - live foreign holder  → { acquired: false, holder }   (never steal a live suite)
 *  - dead holder          → steal (unlink + rewrite) → { acquired: true, holder:null }
 *  - lost wx race         → { acquired: false, holder }
 * `meta` must carry at least { pid }.
 */
export async function acquireLock(lockPath, meta) {
    await mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
    const payload = JSON.stringify({ ...meta, ts: Date.now() });

    async function tryWrite() {
        try {
            await writeFile(lockPath, payload, { flag: "wx" });
            return "written";
        } catch (e) {
            if (e && e.code === "EEXIST") return "exists";
            throw e;
        }
    }

    let first = await tryWrite();
    if (first === "written") return { acquired: true, holder: null };

    const existing = await readLock(lockPath);
    if (existing && existing.pid !== meta.pid && isAlive(existing.pid)) {
        return { acquired: false, holder: existing }; // live sibling — block
    }

    // Owner is not live: either a dead holder (parsed, pid gone) or a
    // corrupt/truncated file left by a SIGKILLed writer (readLock → null but
    // the file is present). Both are reclaimable — remove it, then re-attempt
    // the exclusive create. (A live sibling already returned above.)
    try {
        await rm(lockPath).catch(() => {});
    } catch {
        /* ENOENT is fine */
    }
    first = await tryWrite();
    if (first === "written") return { acquired: true, holder: null };

    const winner = await readLock(lockPath);
    if (winner && winner.pid !== meta.pid) return { acquired: false, holder: winner };
    return { acquired: false, holder: existing ?? null };
}

/** Release only if we still own it (never unlink a successor's lock). */
export async function releaseLock(lockPath, myPid) {
    const cur = await readLock(lockPath);
    if (cur?.pid === myPid) await rm(lockPath, { force: true }).catch(() => {});
}

/** Sync backstop for the 'exit' handler (async can't finish there). */
export function releaseLockSync(lockPath, myPid) {
    try {
        const cur = JSON.parse(readFileSync(lockPath, "utf-8"));
        if (cur?.pid === myPid) rmSync(lockPath, { force: true });
    } catch {
        /* absent/corrupt — nothing to release */
    }
}

/** Enumerate top-level tests/*.test.ts — same set the old shell glob matched. */
export function listTestFiles(root = ROOT) {
    return readdirSync(path.join(root, "tests"))
        .filter((f) => f.endsWith(".test.ts"))
        .sort()
        .map((f) => `tests/${f}`);
}

/** The exact invocation the old `test` script ran, relocated here verbatim. */
function realSuiteArgs() {
    return [
        "--import", "./tests/preload-storage-baseline.mjs",
        "--import", "tsx",
        "--test",
        ...listTestFiles(),
    ];
}

/**
 * Spawn the suite and resolve with its exit code. Test seam: when
 * BILI_TEST_SUITE_CMD is set to a JSON argv array it replaces [execPath, …args]
 * entirely (lets the regression test observe acquire/release without a full run).
 */
function runSuite() {
    let cmd = process.execPath;
    let args = realSuiteArgs();
    const seam = process.env.BILI_TEST_SUITE_CMD;
    if (seam && seam.length > 0) {
        try {
            const parsed = JSON.parse(seam);
            if (Array.isArray(parsed) && parsed.length > 0) {
                cmd = parsed[0];
                args = parsed.slice(1);
            }
        } catch {
            console.error("[test-suite-lock] BILI_TEST_SUITE_CMD is not a JSON string array — ignoring");
        }
    }
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
        } catch (e) {
            console.error(`[test-suite-lock] failed to spawn suite runner: ${e && e.message}`);
            resolve(1);
            return;
        }
        // Forward terminal signals so a Ctrl-C through npm still reaches the
        // child (which may sit in its own group under some launchers). The
        // 'exit' backstop in main() releases the lock on the forced exit.
        for (const sig of ["SIGINT", "SIGTERM"]) {
            process.on(sig, () => {
                try {
                    child.kill(sig);
                } catch { /* already gone */ }
                setTimeout(() => process.exit(130), 3000).unref();
            });
        }
        child.on("error", (e) => {
            console.error(`[test-suite-lock] suite runner error: ${e.message}`);
            resolve(1);
        });
        child.on("close", (code, signal) => {
            resolve(code === null ? (signal ? 1 : 0) : code);
        });
    });
}

async function main() {
    const mode = process.argv[2] ?? "run";
    const lockPath = resolveLockPath();

    if (forceEnabled()) {
        if (mode === "gate") return 0;
        return await runSuite(); // explicit override: run unlocked
    }

    if (mode === "gate") {
        const holder = await readLock(lockPath);
        if (!holder || !isAlive(holder.pid)) return 0; // none, or stealable
        console.error(blockedMessage(holder, lockPath));
        return 1;
    }

    // mode === "run": own the lock across build-less suite execution.
    const meta = { pid: process.pid, cmdline: process.argv.join(" "), cwd: process.cwd() };
    const res = await acquireLock(lockPath, meta);
    if (!res.acquired) {
        if (res.holder) console.error(blockedMessage(res.holder, lockPath));
        else console.error(`[test-suite-lock] could not claim ${lockPath}; another suite likely owns it.`);
        return 1;
    }
    process.on("exit", () => releaseLockSync(lockPath, process.pid));
    let code;
    try {
        code = await runSuite();
    } finally {
        await releaseLock(lockPath, process.pid);
    }
    return code;
}

// Run only when invoked directly (not when imported by the regression test).
const INVOKED_DIRECTLY = (() => {
    if (!process.argv[1]) return false;
    try {
        return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
})();
if (INVOKED_DIRECTLY) {
    main().then(
        (code) => process.exit(code),
        (e) => {
            console.error(`[test-suite-lock] crashed: ${e?.stack ?? e}`);
            process.exit(1);
        },
    );
}
