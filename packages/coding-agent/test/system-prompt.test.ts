import type { Api, Model } from "theoses-ai/compat";
import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("persona and project context", () => {
		const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

		test("emits a THEOSES.md context file once, as persona only", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/agent/THEOSES.md", content: "GLOBAL-PERSONA-BODY" }],
				cwd: process.cwd(),
			});

			expect(count(prompt, "GLOBAL-PERSONA-BODY")).toBe(1);
			expect(prompt).toContain("<persona>\nGLOBAL-PERSONA-BODY\n</persona>");
			expect(prompt).not.toContain("<project_context>");
		});

		test("keeps global and workspace personas once each, in order", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/agent/THEOSES.md", content: "GLOBAL-PERSONA-BODY" },
					{ path: "/ws/procura/THEOSES.md", content: "WORKSPACE-PERSONA-BODY" },
				],
				cwd: "/ws/procura",
			});

			expect(count(prompt, "GLOBAL-PERSONA-BODY")).toBe(1);
			expect(count(prompt, "WORKSPACE-PERSONA-BODY")).toBe(1);
			expect(prompt.indexOf("GLOBAL-PERSONA-BODY")).toBeLessThan(prompt.indexOf("WORKSPACE-PERSONA-BODY"));
		});

		test("still lists AGENTS.md under project_context next to a persona", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/agent/THEOSES.md", content: "GLOBAL-PERSONA-BODY" },
					{ path: "/ws/daily-quote/AGENTS.md", content: "WORKSPACE-AGENTS-BODY" },
				],
				cwd: "/ws/daily-quote",
			});

			expect(count(prompt, "GLOBAL-PERSONA-BODY")).toBe(1);
			expect(count(prompt, "WORKSPACE-AGENTS-BODY")).toBe(1);
			expect(prompt).toContain('<project_instructions path="/ws/daily-quote/AGENTS.md">');
			expect(prompt).not.toContain('<project_instructions path="/agent/THEOSES.md">');
		});

		test("applies to the custom prompt branch too", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "CUSTOM",
				contextFiles: [{ path: "/agent/THEOSES.md", content: "GLOBAL-PERSONA-BODY" }],
				cwd: process.cwd(),
			});

			expect(count(prompt, "GLOBAL-PERSONA-BODY")).toBe(1);
			expect(prompt).not.toContain("<project_context>");
		});
	});

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve Theoses docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"Resolve docs/... and examples/... under these paths, not the current working directory",
			);
			expect(prompt).toContain("environment-variables.md");
		});
	});

	describe("structural sections", () => {
		test("merges efficiency guidance into one section and keeps the safety sections", () => {
			const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: process.cwd() });

			expect(prompt).toContain("<efficiency>");
			for (const removed of [
				"tool_call_efficiency",
				"plan_before_acting",
				"proactivity_scope",
				"no_redundant_rechecks",
			]) {
				expect(prompt).not.toContain(`<${removed}>`);
			}
			expect(prompt).toContain("<no_blocking_waits>");
			expect(prompt).toContain("<collaboration>");
			expect(prompt).toContain("<verification>");
			expect(prompt).not.toContain("<destructive_action_caution>");
			expect(prompt).toContain("<remember_guidance>");
			expect(prompt).toContain("<working_note_guidance>");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	test("injects a bounded non-authoritative Working Note", () => {
		const prompt = buildSystemPrompt({
			workingNote: "x".repeat(3000),
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("Established by earlier turns; verify this note if it contradicts current evidence.");
		expect(prompt).toContain("x".repeat(1000));
		expect(prompt).not.toContain("x".repeat(1001));
	});

	describe("reasoning budget note", () => {
		// Production shape: no explicit compat, so thinkingFormat "openrouter" comes from provider detection.
		const model = (provider: string, maxTokens = 64000) =>
			({
				id: "xiaomi/mimo-v2.6-pro",
				provider,
				api: "openai-completions",
				baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
				maxTokens,
				contextWindow: 128000,
				reasoning: true,
			}) as unknown as Model<Api>;
		const build = (options: Partial<Parameters<typeof buildSystemPrompt>[0]>) =>
			buildSystemPrompt({ contextFiles: [], skills: [], cwd: process.cwd(), ...options });

		test("states the configured budget for an auto-detected OpenRouter model", () => {
			const prompt = build({ model: model("openrouter"), thinkingLevel: "high", thinkingBudgets: { high: 16384 } });
			expect(prompt).toContain("<reasoning_budget>");
			expect(prompt).toContain("capped at 16384 tokens");
		});

		test("clamps the budget to leave room for the answer, like the request does", () => {
			const prompt = build({
				model: model("openrouter", 8000),
				thinkingLevel: "high",
				thinkingBudgets: { high: 16384 },
			});
			expect(prompt).toContain(`capped at ${8000 - 1024} tokens`);
		});

		test("is absent for non-OpenRouter models, thinking off, or no model", () => {
			expect(build({ model: model("openai"), thinkingLevel: "high" })).not.toContain("<reasoning_budget>");
			expect(build({ model: model("openrouter"), thinkingLevel: "off" })).not.toContain("<reasoning_budget>");
			expect(build({ thinkingLevel: "high" })).not.toContain("<reasoning_budget>");
		});
	});
});
