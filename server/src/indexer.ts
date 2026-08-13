/**
 * VaultIndexer — cron drain + resumable backfill for the Vectorize index.
 *
 * Runs on the main Worker (biggest CPU budget). Talks to the vault DO via RPC
 * (claimIndexBatch / markIndexDone / indexStats) so the queue survives DO
 * eviction (it lives in DO SQLite).
 *
 * Pipeline per batch: claim → chunk → embed (qwen3-embedding-0.6b, 1024d)
 * → upsert Vectorize → mark done.
 */

import type { Env } from "./routes/types";
import { chunkMarkdown, chunkIdFor } from "./indexQueue";
import { getServerByName } from "partyserver";

export const EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const MAX_AI_BATCH = 256;
const MAX_BATCHES_PER_RUN = 20; // 20 × 64 docs ≈ 1,280 docs/run (hourly)

interface ClaimedBatch {
	items: { path: string; text: string; hash: string }[];
}

function vaultStub(env: Env, vaultId: string): Promise<DurableObjectStub> {
	return getServerByName(env.YAOS_SYNC, vaultId);
}

async function claimBatch(env: Env, vaultId: string): Promise<ClaimedBatch> {
	const res = await (await vaultStub(env, vaultId)).fetch("https://internal/__yaos/index/claim");
	if (!res.ok) return { items: [] };
	return (await res.json()) as ClaimedBatch;
}

async function markDone(env: Env, vaultId: string, paths: string[], chunkIds: string[]): Promise<void> {
	await (await vaultStub(env, vaultId)).fetch("https://internal/__yaos/index/done", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paths, chunkIds }),
	});
}

/**
 * The hourly cron drain. Budget-capped; resumes next run.
 */
export async function drainIndexQueue(
	env: Env,
	vaultId: string,
): Promise<{ processed: number; vectors: number; remaining: number }> {
	const index = env.YAOS_VECTOR;
	const ai = env.AI;
	if (!index || !ai) {
		return { processed: 0, vectors: 0, remaining: 0 };
	}

	let processed = 0;
	let vectors = 0;
	for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
		const batch = await claimBatch(env, vaultId);
		if (batch.items.length === 0) break;
		try {
			const texts: string[] = [];
			const jobs: { path: string; chunkId: string }[] = [];
			for (const item of batch.items) {
				const chunks = chunkMarkdown(item.path, item.text);
				for (const c of chunks) {
					texts.push(c.text);
					jobs.push({ path: item.path, chunkId: await chunkIdFor(item.path, Number(c.id)) });
				}
			}

			const allVectors: { id: string; values: number[]; metadata: { path: string; updated: number } }[] = [];
			for (let s = 0; s < texts.length; s += MAX_AI_BATCH) {
				const slice = texts.slice(s, s + MAX_AI_BATCH);
				const resp = await ai.run(EMBED_MODEL, { text: slice }) as {
					shape: [number, number];
					data: number[][];
				};
				for (let j = 0; j < slice.length; j++) {
					const values = resp.data[j];
					if (!values) continue;
					const job = jobs[s + j];
					if (!job) continue;
					allVectors.push({
						id: job.chunkId,
						values,
						metadata: { path: job.path, updated: Date.now() },
					});
				}
			}

			if (allVectors.length > 0) {
				await index.upsert(allVectors);
				vectors += allVectors.length;
			}
			await markDone(env, vaultId, batch.items.map((b) => b.path), allVectors.map((v) => v.id));
			processed += batch.items.length;
		} catch (err) {
			// Keep going with the next batch; stale-inflight reclaim will retry
			// this one on the next run.
			console.error(`[yaos-indexer] batch failed:`, err);
		}
	}

	const stats = await indexStats(env, vaultId);
	return { processed, vectors, remaining: stats.pending ?? 0 };
}

async function indexStats(env: Env, vaultId: string): Promise<Record<string, number>> {
	const res = await (await vaultStub(env, vaultId)).fetch("https://internal/__yaos/index/stats");
	if (!res.ok) return {};
	return (await res.json()) as Record<string, number>;
}

export async function getIndexStats(env: Env, vaultId: string): Promise<Record<string, number>> {
	return indexStats(env, vaultId);
}

/**
 * Resumable backfill: HTTP-triggered (unlimited wall time), drains pending
 * rows in batches until the queue is empty. Idempotent by hash.
 */
export async function runBackfill(
	env: Env,
	vaultId: string,
): Promise<{ processed: number; vectors: number; remaining: number }> {
	return drainIndexQueue(env, vaultId);
}
