/**
 * Generic diagnostics report builder (#3040).
 *
 * One reusable facility behind every web warning: assemble a ready-to-paste
 * diagnostic blob (environment facts + one topic-specific section) plus a
 * prefilled GitHub issue link, so any future warning can offer "copy
 * diagnostics / report on GitHub" without inventing its own plumbing. The
 * first consumer is the SQLite legacy-only degradation banner
 * (topic `storage-legacy-only`).
 *
 * Contract: NEVER throws — every fs/listSessions access is guarded so a
 * broken log file or an unbuilt store degrades the blob, not the endpoint.
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { getLogPath } from "../logger.js";
import { defaultLogFile } from "../paths.js";
import { listSessions } from "../session.js";
import { storageDiagnosticsLines } from "../storage/runtime-status.js";
import { BUILD_COMMIT, PACKAGE_NAME, VERSION } from "../version.js";

const GITHUB_NEW_ISSUE_URL = "https://github.com/ranxianglei/billion-context/issues/new";
const STORAGE_LOG_TAIL_LINES = 12;

function humanUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function baseLines(): string[] {
    return [
        `=== ${PACKAGE_NAME} diagnostics ===`,
        `generated: ${new Date().toISOString()}`,
        `bili version: ${VERSION} (commit ${BUILD_COMMIT})`,
        `node: ${process.version}`,
        `platform: ${process.platform} ${process.arch}`,
        `os: ${os.type()} ${os.release()}`,
        `uptime: ${humanUptime(process.uptime())}`,
    ];
}

/** Last N `[storage]` lines across the rotated pair (same candidate recipe as
 *  sendWebLogs); empty on any fs failure. */
function storageLogTail(): string[] {
    try {
        const logFile = getLogPath() ?? defaultLogFile();
        const dir = logFile ? path.dirname(logFile) + path.sep : "";
        const candidates = [dir + "bili.log.old", dir + "bili.log"];
        let lines: string[] = [];
        for (const f of candidates) {
            try { if (!statSync(f).isFile()) continue; } catch { continue; }
            try {
                lines = lines.concat(readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0 && l.includes("[storage]")));
            } catch { continue; }
        }
        return lines.slice(-STORAGE_LOG_TAIL_LINES);
    } catch {
        return [];
    }
}

function safeSessionCount(): number {
    try { return listSessions().length; } catch { return -1; }
}

interface TopicContext {
    sessions: number;
    storageLogLines: string[];
}

interface TopicDef {
    title: () => string;
    section: (ctx: TopicContext) => string[];
}

const TOPICS: Record<string, TopicDef> = {
    "storage-legacy-only": {
        title: () => `SQLite unified storage degraded to legacy-only (bili v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`,
        section: (ctx) => storageDiagnosticsLines(ctx),
    },
};

interface DiagnosticsReport {
    blob: string;
    title: string;
    url: string;
}

export function buildDiagnostics(topic?: string): DiagnosticsReport {
    const t = topic?.trim().slice(0, 64) ?? "";
    const def = t ? TOPICS[t] : undefined;
    const ctx: TopicContext = {
        sessions: safeSessionCount(),
        storageLogLines: def ? storageLogTail() : [],
    };
    const lines = baseLines();
    if (t && !def) lines.push(`topic: ${t} (no topic-specific section registered)`);
    if (def) lines.push(...def.section(ctx));
    const blob = lines.join("\n");
    const title = def
        ? def.title()
        : `bili diagnostics report (v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`;
    const url = `${GITHUB_NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(blob)}`;
    return { blob, title, url };
}
