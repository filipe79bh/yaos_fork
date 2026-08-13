/**
 * YAOS fork — Web Vault (browser editor).
 *
 * Joins the same Yjs sync room as the Obsidian plugin, so the browser edits
 * the real vault live. Auth via the existing ticket flow:
 *
 *   1. User pastes host + token + vaultId (or the mobile-setup URL).
 *   2. POST /vault/:vaultId/auth/ticket  (Authorization: Bearer token)
 *   3. YSyncProvider connects to /vault/sync/:vaultId?ticket=...&schemaVersion=3
 *   4. File list from pathToId/idToText/meta maps; vditor binds the Y.Text.
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import Vditor from "vditor";

declare global {
	interface Window {
		__YAOS_WEB__: YaosWeb;
	}
}

const SCHEMA_VERSION = 3;
const TICKET_TTL_BUFFER_MS = 30_000;

interface CachedTicket {
	value: string;
	expiresAt: number;
}

interface FileEntry {
	path: string;
	fileId: string;
}

export class YaosWeb {
	private host = "";
	private token = "";
	private vaultId = "";
	private ydoc: Y.Doc | null = null;
	private provider: YSyncProvider | null = null;
	private vditor: Vditor | null = null;
	private currentPath: string | null = null;
	private ticketCache: CachedTicket | null = null;
	private ytextObserver: ((e: Y.YTextEvent, t: Y.Transaction) => void) | null =
		null;
	private ytextObserved: Y.Text | null = null;
	/** True while this client is pushing local edits (loop guard). */
	private pushingLocal = false;
	/** Last value this client pushed, to skip echo updates. */
	private lastPushedValue: string | null = null;

	private readonly filesEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly editorEl: HTMLElement;

	constructor() {
		this.filesEl = document.getElementById("files")!;
		this.statusEl = document.getElementById("status")!;
		this.editorEl = document.getElementById("editor")!;
		this.bindUi();
		this.trySetupUrl();
	}

	// ------------------------------------------------------------------
	// UI wiring
	// ------------------------------------------------------------------

	private bindUi(): void {
		document
			.getElementById("connect-btn")!
			.addEventListener("click", () => void this.connectFromForm());
		document
			.getElementById("files-btn")!
			.addEventListener("click", () => this.filesEl.classList.toggle("hidden"));
		const urlInput = document.getElementById("setup-url") as HTMLInputElement;
		const saved = localStorage.getItem("yaos-web-setup");
		if (saved) urlInput.value = saved;
	}

	private trySetupUrl(): void {
		const h = new URLSearchParams(location.hash.replace(/^#/, ""));
		if (h.get("host") && h.get("token") && h.get("vaultId")) {
			const raw = `${h.get("host")}#${h.toString()}`;
			(document.getElementById("setup-url") as HTMLInputElement).value =
				raw;
			void this.connectFromForm();
		}
	}

	private setStatus(msg: string, kind: "info" | "error" | "ok" = "info"): void {
		this.statusEl.textContent = msg;
		this.statusEl.className = `status ${kind}`;
	}

	// ------------------------------------------------------------------
	// Connect
	// ------------------------------------------------------------------

	private async connectFromForm(): Promise<void> {
		const raw = (
			document.getElementById("setup-url") as HTMLInputElement
		).value.trim();
		if (!raw) {
			this.setStatus("Paste your setup URL first.", "error");
			return;
		}
		// Accept either a full mobile-setup URL or a bare fragment string.
		let hash: URLSearchParams;
		if (raw.includes("#")) {
			hash = new URLSearchParams(raw.split("#")[1]);
		} else {
			hash = new URLSearchParams(raw.replace(/^\?/, ""));
		}
		const host = (hash.get("host") || "").trim().replace(/\/+$/, "");
		const token = (hash.get("token") || "").trim();
		const vaultId = (hash.get("vaultId") || "").trim();
		if (!host || !token || !vaultId) {
			this.setStatus(
				"Setup URL must contain host, token and vaultId.",
				"error",
			);
			return;
		}
		this.host = host;
		this.token = token;
		this.vaultId = vaultId;
		localStorage.setItem("yaos-web-setup", raw);
		await this.connect();
	}

	private async getTicket(): Promise<string> {
		const now = Date.now();
		if (
			this.ticketCache &&
			this.ticketCache.expiresAt - now > TICKET_TTL_BUFFER_MS
		) {
			return this.ticketCache.value;
		}
		const res = await fetch(
			`${this.host}/vault/${encodeURIComponent(this.vaultId)}/auth/ticket`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}` },
			},
		);
		if (!res.ok) {
			throw new Error(`ticket request failed (${res.status})`);
		}
		const body = (await res.json()) as {
			ticket?: string;
			expiresAt?: number;
		};
		if (!body.ticket || typeof body.expiresAt !== "number") {
			throw new Error("ticket response invalid");
		}
		this.ticketCache = { value: body.ticket, expiresAt: body.expiresAt };
		return body.ticket;
	}

	private async connect(): Promise<void> {
		this.setStatus("Connecting…", "info");
		this.provider?.destroy();
		this.vditor?.destroy();
		this.vditor = null;
		this.ytextObserver = null;
		this.ytextObserved = null;
		this.currentPath = null;
		this.ydoc = new Y.Doc();

		const wsHost = this.host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
		const syncPrefix = `/vault/sync/${encodeURIComponent(this.vaultId)}`;

		this.provider = new YSyncProvider(wsHost, this.vaultId, this.ydoc, {
			prefix: syncPrefix,
			params: async () => {
				const ticket = await this.getTicket();
				return {
					schemaVersion: String(SCHEMA_VERSION),
					device: "yaos-web",
					ticket,
				};
			},
			connect: true,
		});

		this.provider.on("status", (ev: { status: string }) => {
			if (ev.status === "connected") {
				this.setStatus("Connected — syncing…", "ok");
			} else {
				this.setStatus(`Sync: ${ev.status}`, "info");
			}
		});

		this.ydoc.on("update", () => this.refreshFileList());
		this.refreshFileList();
		this.setStatus("Waiting for initial sync…", "info");
	}

	// ------------------------------------------------------------------
	// File list
	// ------------------------------------------------------------------

	private refreshFileList(): void {
		if (!this.ydoc) return;
		const pathToId = this.ydoc.getMap<string>("pathToId");
		const meta = this.ydoc.getMap("meta");
		const files: FileEntry[] = [];
		pathToId.forEach((fileId, path) => {
			const m = meta.get(fileId) as
				| { path?: string; deleted?: boolean }
				| undefined;
			if (m?.deleted) return;
			files.push({ path, fileId });
		});
		files.sort((a, b) => a.path.localeCompare(b.path));

		this.filesEl.innerHTML = "";
		if (files.length === 0) {
			const empty = document.createElement("div");
			empty.className = "file empty";
			empty.textContent = "No notes synced yet.";
			this.filesEl.appendChild(empty);
			return;
		}
		for (const f of files) {
			const row = document.createElement("button");
			row.className = "file" + (f.path === this.currentPath ? " active" : "");
			row.textContent = f.path;
			row.addEventListener("click", () => void this.openFile(f));
			this.filesEl.appendChild(row);
		}
	}

	// ------------------------------------------------------------------
	// Editor
	// ------------------------------------------------------------------

	private async openFile(file: FileEntry): Promise<void> {
		if (!this.ydoc) return;
		this.currentPath = file.path;
		this.refreshFileList();

		const idToText = this.ydoc.getMap<Y.Text>("idToText");
		const ytext = idToText.get(file.fileId);
		if (!ytext) {
			this.setStatus(`No content for ${file.path} yet.`, "error");
			return;
		}

		this.bindYTextObserver(ytext, file.path);

		const markdown = ytext.toString();
		this.lastPushedValue = null;

		if (this.vditor) {
			this.vditor.setValue(markdown);
			return;
		}

		this.editorEl.innerHTML = "";
		this.vditor = new Vditor(this.editorEl, {
			height: "calc(100vh - 120px)",
			mode: "ir",
			value: markdown,
			cache: { enable: false },
			input: (value) => this.pushText(ytext, value),
		});
	}

	private pushText(ytext: Y.Text, value: string): void {
		if (this.pushingLocal) return;
		const local = ytext.toString();
		if (local === value) return;
		this.pushingLocal = true;
		try {
			ytext.delete(0, ytext.length);
			ytext.insert(0, value);
			this.lastPushedValue = value;
		} finally {
			this.pushingLocal = false;
		}
	}

	private bindYTextObserver(ytext: Y.Text, path: string): void {
		if (this.ytextObserver && this.ytextObserved) {
			this.ytextObserved.unobserve(this.ytextObserver);
		}
		const fn = (): void => {
			if (this.pushingLocal) return;
			if (this.currentPath !== path || !this.vditor) return;
			const remote = ytext.toString();
			if (this.lastPushedValue !== null && remote === this.lastPushedValue) {
				this.lastPushedValue = null;
				return;
			}
			this.vditor.setValue(remote);
		};
		ytext.observe(fn);
		this.ytextObserver = fn;
		this.ytextObserved = ytext;
	}
}

export function mount(): void {
	window.__YAOS_WEB__ = new YaosWeb();
}

if (typeof document !== "undefined") {
	if (document.readyState === "loading") {
		window.addEventListener("DOMContentLoaded", () => mount());
	} else {
		mount();
	}
}
