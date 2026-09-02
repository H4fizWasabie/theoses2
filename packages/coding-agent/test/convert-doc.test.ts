import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createConvertDocToolDefinition } from "../src/core/tools/convert-doc.ts";

describe("document artifacts", () => {
	it("converts a document through the markitdown operation and resolves relative paths", async () => {
		const cwd = join(tmpdir(), `theoses2-convert-${Date.now()}`);
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "brief.docx"), "document");
		const tool = createConvertDocToolDefinition(cwd, {
			operations: { convert: async (path) => `# Converted\n${path}` },
		});

		const result = await tool.execute("call-1", { path: "brief.docx" }, undefined, undefined, {} as ExtensionContext);

		expect(result.content[0]).toEqual({ type: "text", text: `# Converted\n${join(cwd, "brief.docx")}` });
	});

	it("persists artifacts and omits stale files from the live catalog", async () => {
		const cwd = join(tmpdir(), `theoses2-artifacts-${Date.now()}`);
		await mkdir(cwd, { recursive: true });
		const livePath = join(cwd, "live.pdf");
		await writeFile(livePath, "pdf");
		const stalePath = join(cwd, "gone.pdf");
		const session = SessionManager.inMemory(cwd);
		session.appendArtifact("live document", livePath, 3);
		session.appendArtifact("stale document", stalePath, 4);

		const catalog = session.getArtifactCatalog();

		expect(catalog).toContain("live document");
		expect(catalog).not.toContain("stale document");
	});
});
