/**
 * VaultIndexStore — write-time snapshot + incremental embed queue (fork feature).
 *
 * Design (council-approved):
 *   - onSave() in the DO computes plaintext per changed doc and writes it to a
 *     SQLite `docs_index` staging table (survives DO eviction).
 *   - An hourly cron drains `pending` rows: chunk → embed (qwen3-embedding-0.6b)
 *     → upsert into Vectorize, then marks rows done.
 *   - A resumable HTTP backfill endpoint (with `indexed_at` checkpoint) handles
 *     the initial 15k-doc load, because the 15-min cron wall + Workers AI rate
 *     limit cannot absorb a full backfill in one run.
 *
 * Text snapshot lives in SQLite, NOT in Vectorize metadata (10 KiB metadata
 * cap / 10 filterable fields). Vectorize metadata = { path, updated } only.
 */

import type { DurableObjectStorageWithSql } from "./sqlDocStore";

export interface IndexQueueRow {
	path: string;
	hash: string;
	status: "pending" | "inflight" | "done" | "deleted";
	text: string | null;
	updated_at: number;
	indexed_at: number | null;
	chunk_ids: string;
}

export interface PendingBatchItem {
	path: string;
	text: string;
	hash: string;
}

const BATCH_LIMIT = 64;

/**
 * Deterministic chunk ID: sha1-hex of path + chunk index.
 * < 64 bytes (Vectorize ID limit): 40 + "-" + up to 3 = ~44 chars.
 */
export async function chunkIdFor(path: string, index: number): Promise<string> {
	const data = new TextEncoder().encode(path);
	const digest = await crypto.subtle.digest("SHA-1", data);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex}-${index}`;
}

/**
 * Heading-aware markdown chunker.
 * Sections split on ^#{1,3} when the doc exceeds 1,500 chars; oversized
 * sections split on 1,200-char windows with 200-char overlap. Chunks < 100
 * chars are dropped. Default: one chunk per doc (2KB notes ≈ 550 tokens, well
 * under the 8,192-token qwen context).
 */
export function chunkMarkdown(path: string, text: string): { id: string; text: string }[] {
	const stripped = stripFrontmatter(text);
	if (stripped.trim().length <= 1500) {
		return [{ id: "0", text: `${path}\n${stripped}`.trim() }];
	}

	const lines = stripped.split("\n");
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (/^#{1,3} /.test(line) && current.length > 0) {
			sections.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) sections.push(current.join("\n"));

	const chunks: string[] = [];
	for (const section of sections) {
		if (section.length <= 2000) {
			chunks.push(`${path}\n${section}`);
			continue;
		}
		// Fixed-window split with overlap.
		const window = 1200;
		const overlap = 200;
		for (let i = 0; i < section.length; i += window - overlap) {
			chunks.push(`${path}\n${section.slice(i, i + window)}`);
		}
	}

	return chunks
		.filter((c) => c.length >= 100)
		.map((c, i) => ({ id: String(i), text: c }));
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	return text.slice(end + 4);
}

export class VaultIndexStore {
	constructor(private readonly storage: DurableObjectStorageWithSql) {
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS docs_index (
				path TEXT PRIMARY KEY,
				hash TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				text TEXT,
				updated_at INTEGER NOT NULL,
				indexed_at INTEGER,
				chunk_ids TEXT NOT NULL DEFAULT '[]'
			)
		`);
	}

	/**
	 * Record/refresh a changed document. Called from the DO save path.
	 * Deletions arrive as text === null → status 'deleted'.
	 * Hash = cheap (len*7 base36 + len) — only for change detection, not crypto.
	 */
	markChanged(path: string, text: string | null): void {
		if (text === null) {
			this.storage.sql.exec(
				`UPDATE docs_index SET status = 'deleted' WHERE path = ?`,
				path,
			);
			return;
		}
		const hash = String((text.length * 7).toString(36)) + "-" + (text.length);
		this.storage.sql.exec(
			`INSERT INTO docs_index (path, hash, status, text, updated_at, indexed_at, chunk_ids)
			 VALUES (?, ?, 'pending', ?, ?, NULL, '[]')
			 ON CONFLICT(path) DO UPDATE SET
			   hash = excluded.hash,
			   status = 'pending',
			   text = excluded.text,
			   updated_at = excluded.updated_at,
			   indexed_at = NULL,
			   chunk_ids = '[]'`,
			path,
			hash,
			text,
			Date.now(),
		);
	}

	/**
	 * Hash-aware upsert: only (re)queues when the text actually changed.
	 * Used by reconcile so it never re-queues already-indexed docs.
	 */
	markChangedIfDifferent(path: string, text: string | null): void {
		if (text === null) {
			this.storage.sql.exec(
				`UPDATE docs_index SET status = 'deleted' WHERE path = ?`,
				path,
			);
			return;
		}
		const hash = String((text.length * 7).toString(36)) + "-" + (text.length);
		this.storage.sql.exec(
			`INSERT INTO docs_index (path, hash, status, text, updated_at, indexed_at, chunk_ids)
			 VALUES (?, ?, 'pending', ?, ?, NULL, '[]')
			 ON CONFLICT(path) DO UPDATE SET
			   hash = excluded.hash,
			   status = CASE WHEN docs_index.hash != excluded.hash
			                  THEN 'pending' ELSE docs_index.status END,
			   text = excluded.text,
			   updated_at = excluded.updated_at,
			   indexed_at = CASE WHEN docs_index.hash != excluded.hash
			                     THEN NULL ELSE docs_index.indexed_at END,
			   chunk_ids = CASE WHEN docs_index.hash != excluded.hash
			                    THEN '[]' ELSE docs_index.chunk_ids END`,
			path,
			hash,
			text,
			Date.now(),
		);
	}

	/** Atomic claim: reclaim stale inflight, then claim pending. */
	claimBatch(): PendingBatchItem[] {
		// Reclaim stale inflight rows (claimed by a run that never finished).
		this.storage.sql.exec(
			`UPDATE docs_index SET status = 'pending'
			 WHERE status = 'inflight' AND updated_at < ?`,
			Date.now() - 10 * 60 * 1000,
		);
		const rows = this.storage.sql.exec<Record<string, string | number | null>>(
			`SELECT path, text, hash FROM docs_index
			 WHERE status = 'pending' AND text IS NOT NULL
			 LIMIT ?`,
			BATCH_LIMIT,
		);
		const all = [...rows];
		console.log(`[yaos-index] claimBatch: ${all.length} rows (limit ${BATCH_LIMIT})`);
		const paths = all.map((r) => String(r.path));
		if (paths.length === 0) return [];
		this.storage.sql.exec(
			`UPDATE docs_index SET status = 'inflight' WHERE path IN (${paths.map(() => "?").join(",")})`,
			...paths,
		);
		return all.map((r) => ({ path: String(r.path), text: String(r.text ?? ""), hash: String(r.hash) }));
	}

	markDone(paths: string[], chunkIds: string[]): void {
		if (paths.length === 0) return;
		this.storage.transactionSync(() => {
			for (const path of paths) {
				this.storage.sql.exec(
					`UPDATE docs_index SET status = 'done', indexed_at = ?, chunk_ids = ?
					 WHERE path = ?`,
					Date.now(),
					JSON.stringify(chunkIds),
					path,
				);
			}
		});
	}

	markDeletedDone(paths: string[]): void {
		if (paths.length === 0) return;
		this.storage.sql.exec(
			`DELETE FROM docs_index WHERE path IN (${paths.map(() => "?").join(",")})`,
			...paths,
		);
	}

	/** Pending rows for backfill/resume; chunked via indexed_at checkpoint. */
	stats(): Record<string, number> {
		const [s] = this.storage.sql.exec<{ cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM docs_index`,
		);
		const [p] = this.storage.sql.exec<{ cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM docs_index WHERE status = 'pending'`,
		);
		const [d] = this.storage.sql.exec<{ cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM docs_index WHERE status = 'deleted'`,
		);
		const [i] = this.storage.sql.exec<{ cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM docs_index WHERE indexed_at IS NOT NULL`,
		);
		return {
			total: s?.cnt ?? 0,
			pending: p?.cnt ?? 0,
			deleted: d?.cnt ?? 0,
			indexed: i?.cnt ?? 0,
		};
	}

	allPaths(): string[] {
		const rows = this.storage.sql.exec<{ path: string }>(
			`SELECT path FROM docs_index`,
		);
		return [...rows].map((r) => r.path);
	}

	/** Raw row dump for debugging. */
	dump(): { path: string; status: string; textLen: number; updatedAt: number; hash: string }[] {
		const rows = this.storage.sql.exec<Record<string, string | number | null>>(
			`SELECT path, status, text, updated_at, hash FROM docs_index`,
		);
		return [...rows].map((r) => ({
			path: String(r.path),
			status: String(r.status),
			textLen: r.text === null ? -1 : String(r.text).length,
			updatedAt: Number(r.updated_at),
			hash: String(r.hash),
		}));
	}
}
