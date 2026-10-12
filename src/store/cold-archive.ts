/**
 * Cold archive — the tier below the hot markdown stores.
 *
 * When fifo-evict rotates entries out of MEMORY.md / USER.md / failures.md,
 * they are archived here instead of being dropped on the floor:
 *
 * - `COLD.md`   — verbatim evicted entries with provenance headers
 * - `INDEX.md`  — one greppable line per cold entry, the "check here" pointer
 *
 * Both live next to the hot store they serve (same directory, same scope),
 * and are written atomically (temp dir + rename) before the eviction result
 * is returned, so the archive and the index can never diverge from the hot
 * store's state: the write happens in the same operation as the eviction.
 *
 * Design notes:
 * - Entry IDs are deterministic (sha256 of target+text, first 10 hex chars),
 *   so re-evicting identical content dedupes instead of duplicating.
 * - The index line is a dumb summary (first ~90 chars). Search quality comes
 *   from grep over COLD.md/INDEX.md; the hot tier stays the LLM-facing cache.
 * - Archive failures never block eviction — the entries still surface in the
 *   tool result, which is the pre-archive behavior. Cold archival is best
 *   effort, hot-store correctness is mandatory.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { COLD_FILE, INDEX_FILE } from "../constants.js";

export type ColdTarget = "memory" | "user" | "failure";

export interface ColdEntry {
  /** Entry text with metadata comment stripped. */
  text: string;
  created: string;
  lastReferenced: string;
  project: string | null;
}

export interface ColdArchiveResult {
  /** Path of the archive file entries were appended to. */
  coldPath: string;
  /** Path of the index file lines were appended to. */
  indexPath: string;
  /** IDs of entries newly archived (already-present IDs are skipped). */
  archivedIds: string[];
}

const ID_HASH_INPUT_PREFIX = "cold-archive/v1";

/** Deterministic short ID for an evicted entry. */
export function coldEntryId(target: ColdTarget, text: string): string {
  return createHash("sha256")
    .update(`${ID_HASH_INPUT_PREFIX}\n${target}\n${text.trim()}`)
    .digest("hex")
    .slice(0, 10);
}

/** Collapse whitespace and clamp to a one-line index summary. */
function summarize(text: string, maxChars = 90): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars
    ? collapsed.slice(0, maxChars - 1).trimEnd() + "…"
    : collapsed;
}

function coldEntryBlock(id: string, target: ColdTarget, entry: ColdEntry): string {
  const provenance = [
    `id=${id}`,
    `target=${target}`,
    `created=${entry.created || "unknown"}`,
    `last=${entry.lastReferenced || "unknown"}`,
    `project=${entry.project ?? "-"}`,
  ].join(" · ");
  return `### ${provenance}\n\n${entry.text.trim()}`;
}

function indexLine(id: string, target: ColdTarget, entry: ColdEntry): string {
  const project = entry.project ? ` project=${entry.project}` : "";
  return `- [${id}] (${target}${project}) ${summarize(entry.text)} [${entry.created || "unknown"}]`;
}

async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Atomic-ish write: temp dir in the same directory, then rename. */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(path.dirname(filePath), ".tmp-cold-"));
  const tmpPath = path.join(tmpDir, "write.tmp");
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Append evicted entries to COLD.md and INDEX.md in `memoryDir`.
 * Entries whose ID already appears in COLD.md are skipped (dedup).
 */
export async function appendEvictedToColdArchive(
  memoryDir: string,
  target: ColdTarget,
  entries: ColdEntry[],
): Promise<ColdArchiveResult> {
  const coldPath = path.join(memoryDir, COLD_FILE);
  const indexPath = path.join(memoryDir, INDEX_FILE);

  const existingCold = await readIfExists(coldPath);
  const existingIndex = await readIfExists(indexPath);

  const seenIds = new Set(
    existingCold
      .split("\n")
      .filter((line) => line.startsWith("### id="))
      .map((line) => {
        const match = line.match(/^### id=([0-9a-f]{10})\b/);
        return match ? match[1] : "";
      })
      .filter(Boolean),
  );

  const archivedIds: string[] = [];
  const coldBlocks: string[] = [];
  const indexLines: string[] = [];

  for (const entry of entries) {
    const id = coldEntryId(target, entry.text);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    archivedIds.push(id);
    coldBlocks.push(coldEntryBlock(id, target, entry));
    indexLines.push(indexLine(id, target, entry));
  }

  if (archivedIds.length > 0) {
    const coldContent =
      (existingCold ? existingCold.replace(/\s*$/, "\n") : "# Cold archive — evicted memory entries (verbatim, with provenance)\n\n")
      + coldBlocks.join("\n\n")
      + "\n";
    const indexContent =
      (existingIndex ? existingIndex.replace(/\s*$/, "\n") : "# Cold archive index — one line per evicted entry; full text in COLD.md\n\n")
      + indexLines.join("\n")
      + "\n";
    await atomicWrite(coldPath, coldContent);
    await atomicWrite(indexPath, indexContent);
  }

  return { coldPath, indexPath, archivedIds };
}
