/**
 * Builds the YAOS Web Vault static assets into server/public/web/.
 *
 *   - bundles web-app/web-vault.ts (yjs + y-partyserver + vditor) into app.js
 *   - copies the minimal vditor runtime (index.css, index.min.js, lute,
 *     highlight.js, icons, i18n, content themes) from node_modules
 *
 * The resulting directory is served by Cloudflare static assets (assets
 * binding in wrangler.jsonc) at /web/*; everything else still hits the Worker.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const serverDir = resolve(import.meta.dirname ?? ".");
const webAppDir = join(serverDir, "web-app");
const outDir = join(serverDir, "public/web");
const vditorDist = join(serverDir, "node_modules/vditor/dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "vditor"), { recursive: true });

// 1. Bundle the app.
execFileSync(
	"npx",
	[
		"esbuild",
		join(webAppDir, "web-vault.ts"),
		"--bundle",
		"--format=esm",
		"--target=es2022",
		"--minify",
		"--outfile=" + join(outDir, "app.js"),
	],
	{ stdio: "inherit" },
);

// 2. Copy vditor runtime files.
const vditorFiles = [
	"index.css",
	"index.min.js",
	"method.min.js",
	"images",
	"js/lute",
	"js/highlight.js",
	"js/icons",
	"js/i18n",
	"css/content-theme",
];
for (const f of vditorFiles) {
	cpSync(join(vditorDist, f), join(outDir, "vditor", f), {
		recursive: true,
	});
}

// 3. Copy the page.
cpSync(join(webAppDir, "index.html"), join(outDir, "index.html"));

console.log(`Web Vault assets built → ${outDir}`);
