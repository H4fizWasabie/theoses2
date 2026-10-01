import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "theoses-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClaimProblem } from "../src/core/claim-check.ts";
import { applyPlanAction, type TaskPlan, verifyOutput } from "../src/core/task-plan.ts";
import { commandEffect, isCheckCommand, type ToolRun } from "../src/core/tool-runs.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createTaskPlanToolDefinition } from "../src/core/tools/task-plan.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

let nextId = 0;
function tool(name: string, args: Record<string, unknown>, output = "PASS", isError = false): AgentMessage[] {
	const id = `evidence-${nextId++}`;
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError,
			timestamp: 0,
		},
	] as AgentMessage[];
}
function run(command: string, name = "bash"): ToolRun {
	return { id: "run", name, command, path: undefined, output: "PASS", isError: false };
}
const CHECK = "node tests/feature.mjs";
function create(command = CHECK): TaskPlan {
	const result = applyPlanAction(
		undefined,
		{
			action: "create",
			goal: "fix feature",
			items: ["feature"],
			verify: "feature assertions pass",
			verify_command: command,
		},
		{ runMessages: [], request: "fix feature" },
	);
	if (!result.plan) throw new Error(result.error);
	return result.plan;
}
function close(plan: TaskPlan, messages: AgentMessage[], id = 2) {
	return applyPlanAction(
		plan,
		{ action: "update", id, status: "done" },
		{ runMessages: messages, request: "fix feature" },
	);
}

describe("runtime verification classification", () => {
	it.each(["bash", "powershell"])("rejects syntax-only evidence through %s", (name) => {
		expect(isCheckCommand(run("node --check unrelated.mjs", name))).toBe(false);
	});
	it.each([
		"node --help",
		"node -h",
		"node --version",
		"node -v",
		"NODE.EXE --help",
		"node",
		"node --require setup.js --help",
		"node -e 'process.exit(7)' --version",
		"npx node --help",
		"python3 --help",
		"python3 --version",
		"ruby --version",
		"perl -v",
		"deno --help",
		"bun --version",
		"pytest --help",
		"python3 -m pytest --help",
		"pytest --collect-only",
		"npx vitest --help",
		"jest --listTests",
		"go test --help",
		"cargo test --help",
		"dotnet test --help",
		"npm test --help",
		"pnpm test --help",
		"yarn test --help",
		"bash -lc 'node --help'",
		"node --help && node --version",
		"python3 -m pytest --collect-only",
		"vitest list",
		"deno info",
		"deno types",
		"deno help",
		"deno completions",
		"bun build app.js",
		"bun pm",
	])("rejects information-only %s", (command) => {
		expect(isCheckCommand(run(command))).toBe(false);
		expect(() => create(command)).toThrow(/runtime/);
	});
	it.each([
		"node -c unrelated.js",
		"python3 -m py_compile app.py",
		"python -m compileall .",
		"tsc --noEmit",
		"npx tsc --noEmit",
		"biome check .",
		"npx eslint src",
		"ruff check .",
		"go vet ./...",
		"cargo check",
		"set -e; node --check unrelated.js",
		"bash -lc 'node --check unrelated.js'",
		"npm run lint",
		"npm run build",
		"npm run typecheck",
		"bash -n test.sh",
		"ruby -c app.rb",
		"perl -wc app.pl",
		"true || node tests/feature.mjs",
		"node --check app.js || node tests/feature.mjs",
		"node tests/feature.mjs &",
		"node tests/feature.mjs | tail -1",
		"node tests/feature.mjs; true",
		"bash -lc 'true || node tests/feature.mjs'",
		"if false\nnode tests/feature.mjs\nfi",
	])("does not credit %s as a runtime check", (command) => {
		expect(isCheckCommand(run(command))).toBe(false);
	});
	it.each([
		"node tests/feature.mjs",
		"python3 -m pytest tests/test_feature.py",
		"npx vitest run test/feature.test.ts",
		"bash test.sh",
		"npm test",
		"pnpm test",
		"yarn test",
		"go test ./...",
		"node --check app.js && node tests/feature.mjs",
		"set -euo pipefail; node tests/feature.mjs | tail -1",
	])("credits runtime %s", (command) => {
		expect(isCheckCommand(run(command))).toBe(true);
	});
});

// The harness cannot list every ecosystem's runner, so unknown commands are assumed to execute and only
// recognized non-executing forms are refused. These cases span ecosystems the classifier never names.
describe("ecosystem-agnostic classification", () => {
	it.each([
		"make test",
		"make check",
		"just test",
		"task test",
		"mvn test",
		"./mvnw verify",
		"gradle build",
		"./gradlew build",
		"rspec spec/feature_spec.rb",
		"bundle exec rspec",
		"mix test",
		"php artisan test",
		"php vendor/bin/phpunit",
		"tox",
		"./run-tests",
		"bash ./scripts/test",
		"dotnet test",
		"uv run pytest -q",
		"poetry run pytest",
		"timeout 60 npm test",
		"CI=1 ./scripts/test",
		"python3 app.py --help",
		"python3 -m unittest",
		"ruby -rcsv script.rb",
		"mvn install",
		"./gradlew check",
		'mysql -h db.internal -e "select 1"',
		"curl -fsS http://localhost:8080/health",
	])("credits an unfamiliar runner: %s", (command) => {
		expect(isCheckCommand(run(command))).toBe(true);
	});
	it.each([
		"npm run check",
		"npm run lint:fix",
		"pnpm -r typecheck",
		"yarn lint",
		"make build",
		"make lint",
		"just fmt",
		"cargo build --release",
		"cargo clippy",
		"cargo fmt --check",
		"cargo test --no-run",
		"go build ./...",
		"dotnet build",
		"docker build .",
		"pip install -e .",
		"mypy src",
		"uv run mypy .",
		"bundle exec rubocop",
		"shellcheck run.sh",
		"npx prettier --check .",
		"php -l app.php",
		"python3 -V",
		"python3 -m pip install x",
		"timeout 60 tsc --noEmit",
		"dotnet test --list-tests",
		"go test -list .",
		"mvn -q compile",
		"sbt compile",
		"gradle assemble",
		"ruby -wc app.rb",
	])("does not credit a build, lint or listing form: %s", (command) => {
		expect(isCheckCommand(run(command))).toBe(false);
	});
	it("treats -h as a host flag unless it is the only argument", () => {
		expect(isCheckCommand(run("psql -h localhost -c 'select 1'"))).toBe(true);
		expect(isCheckCommand(run("psql -h"))).toBe(false);
	});
	it("tells the model how to proceed when nothing qualifies", () => {
		expect(() => create("npm run lint")).toThrow(/script/);
	});
});

describe("source rewrites are recognized by verb and flag, not only by tool name", () => {
	it.each([
		"cargo fmt",
		"go fmt ./...",
		"dotnet format",
		"npm run format",
		"make fmt",
		"ruff format src",
		"isort src",
		"rustfmt src/main.rs",
		"uv run black .",
		"npx prettier --write .",
		"sudo rm app.js",
		"time sed -i s/a/b/ app.js",
		"timeout 30 touch app.js",
	])("treats %s as a source change", (command) => {
		expect(commandEffect(command, "/srv/project").changesFiles).toBe(true);
	});
	it.each([
		"cargo fmt --check",
		"black --check .",
		"gofmt -l .",
		"ruff format --diff",
		"npm test",
		"grep -w foo a.txt",
	])("does not treat %s as a source change", (command) => {
		expect(commandEffect(command, "/srv/project").changesFiles).toBe(false);
	});
});

describe("scratch locations", () => {
	it.each(["npm test 2>/dev/stderr", "npm test > /dev/stdout", "npm test > /dev/null", "npm test 2>/dev/fd/2"])(
		"treats %s as an output sink",
		(command) => {
			expect(commandEffect(command, "/srv/project").changesFiles).toBe(false);
		},
	);
	it("honours the platform temp directory, not only /tmp", () => {
		const artifact = join(tmpdir(), "verification-artifact.txt");
		expect(commandEffect(`npm test > ${artifact}`, "/srv/project").changesFiles).toBe(false);
		expect(commandEffect(`npm test > ${artifact}`, tmpdir()).changesFiles).toBe(true);
		expect(commandEffect("npm test > /dev/sda", "/srv/project").changesFiles).toBe(true);
	});
});

describe("declared per-item evidence", () => {
	it("binds on the command, not on its spacing", () => {
		const declared = "node tests/feature.mjs   --mode  fast";
		expect(
			close(create(declared), tool("bash", { command: "node tests/feature.mjs --mode fast" })).error,
		).toBeUndefined();
		expect(
			close(create(declared), tool("bash", { command: "node tests/feature.mjs --mode slow" })).error,
		).toBeDefined();
	});
	it("names the exact command to run when none matched", () => {
		expect(close(create(), tool("bash", { command: "node tests/unrelated.mjs" })).error).toContain(`\`${CHECK}\``);
	});
	it("requires an explicit command, separate from the criterion", () => {
		expect(
			applyPlanAction(
				undefined,
				{ action: "create", goal: "g", verify: "feature works" },
				{ runMessages: [], request: "go" },
			).error,
		).toContain("verify_command");
		expect(create().items[1]).toMatchObject({ verifyCommand: CHECK });
	});
	it("refuses a syntax-only declaration", () => {
		expect(() => create("node --check unrelated.mjs")).toThrow(/runtime/);
	});
	it("cannot substitute an unrelated passing runtime command", () => {
		const result = close(create(), [
			...tool("edit", { path: "feature.js" }),
			...tool("bash", { command: "node tests/unrelated.mjs" }),
		]);
		expect(result.error).toBeDefined();
	});
	it.each(["bash", "powershell"])("captures the matching %s result rather than the latest unrelated check", (name) => {
		const matching = tool(name, { command: CHECK }, "feature assertions PASS");
		const messages = [
			...tool("edit", { path: "feature.js" }),
			...matching,
			...tool(name, { command: "node tests/unrelated.mjs" }, "UNRELATED"),
		];
		const result = close(create(), messages);
		expect(result.error).toBeUndefined();
		expect(result.plan?.items[1]).toMatchObject({
			status: "done",
			evidence: {
				toolCallId: matching[1].role === "toolResult" ? matching[1].toolCallId : "",
				command: CHECK,
				output: "feature assertions PASS",
			},
		});
		expect(verifyOutput(result.plan!)).toContain("feature assertions PASS");
		expect(verifyOutput(result.plan!)).not.toContain("UNRELATED");
	});
	it("ignores only outer command whitespace, not changed arguments", () => {
		expect(close(create(), tool("bash", { command: `  ${CHECK}\n` })).error).toBeUndefined();
		expect(close(create(), tool("bash", { command: `${CHECK} --different-mode` })).error).toBeDefined();
	});
	it("does not reuse a command executed before declaration", () => {
		const earlier = tool("bash", { command: CHECK });
		const plan = applyPlanAction(
			undefined,
			{ action: "create", goal: "g", items: ["feature"], verify: "feature works", verify_command: CHECK },
			{ runMessages: earlier, request: "go" },
		).plan!;
		expect(close(plan, earlier).error).toContain("since");
		expect(close(plan, [...earlier, ...tool("bash", { command: CHECK })]).error).toBeUndefined();
	});
	it("requires a new run when reopening without changing the command", () => {
		const earlier = tool("bash", { command: CHECK });
		const closed = close(create(), earlier).plan!;
		const reopened = applyPlanAction(
			closed,
			{ action: "update", id: 2, status: "open" },
			{ runMessages: earlier, request: "go" },
		).plan!;
		expect(close(reopened, earlier).error).toBeDefined();
		expect(close(reopened, [...earlier, ...tool("bash", { command: CHECK })]).error).toBeUndefined();
	});
	it("does not let an unrelated pass mask a newer matching failure", () => {
		const messages = [
			...tool("bash", { command: CHECK }),
			...tool("bash", { command: CHECK }, "feature FAIL", true),
			...tool("bash", { command: "node tests/unrelated.mjs" }),
		];
		expect(close(create(), messages).error).toContain("feature FAIL");
	});
	it("requires rerunning the declared command after a later edit", () => {
		const messages = [...tool("bash", { command: CHECK }), ...tool("edit", { path: "feature.js" })];
		expect(close(create(), messages).error).toBeDefined();
		expect(close(create(), [...messages, ...tool("bash", { command: CHECK })]).error).toBeUndefined();
	});
	it("clears captured evidence when reopened and permits rebinding only while open", () => {
		const closed = close(create(), tool("bash", { command: CHECK })).plan!;
		expect(
			applyPlanAction(
				closed,
				{ action: "update", id: 2, verify_command: "node tests/other.mjs" },
				{ runMessages: [], request: "go" },
			).error,
		).toBeDefined();
		const reopened = applyPlanAction(
			closed,
			{ action: "update", id: 2, status: "open", verify_command: "node tests/other.mjs" },
			{ runMessages: [], request: "go" },
		).plan!;
		expect(reopened.items[1]).toMatchObject({ status: "open", verifyCommand: "node tests/other.mjs" });
		expect(reopened.items[1].evidence).toBeUndefined();
	});
	it("reports both verification items' own outputs, including earlier-turn evidence", () => {
		const first = close(create(), tool("bash", { command: CHECK }, "FEATURE PASS")).plan!;
		const added = applyPlanAction(
			first,
			{ action: "add", items: ["other"], verify: "other works", verify_command: "node tests/other.mjs" },
			{ runMessages: [], request: "go" },
		).plan!;
		const finished = close(added, tool("bash", { command: "node tests/other.mjs" }, "OTHER PASS"), 4).plan!;
		expect(verifyOutput(finished)).toContain("FEATURE PASS");
		expect(verifyOutput(finished)).toContain("OTHER PASS");
	});
	it("bounds stored output with a visible truncation marker", () => {
		const output = `first assertion PASS\n${"x".repeat(10_000)}\nlast assertion PASS`;
		const plan = close(create(), tool("bash", { command: CHECK }, output)).plan!;
		const captured = plan.items[1].evidence?.output ?? "";
		expect(captured.length).toBeLessThan(4500);
		expect(captured).toContain("first assertion PASS");
		expect(captured).toContain("last assertion PASS");
		expect(captured).toContain("truncated");
	});
});

describe("isolated artifacts versus source changes", () => {
	it.each([
		`node -e 'require("node:fs").writeFileSync("/tmp/verification-result.json", "ok")'`,
		`node -e 'const {writeFileSync} = require("node:fs"); writeFileSync("/tmp/verification-result.json", "ok")'`,
		`node --input-type=module -e 'import {writeFileSync} from "node:fs"; writeFileSync("/tmp/verification-result.json", "ok")'`,
		`python3 -c 'open("/tmp/verification-result.txt", "w").write("ok")'`,
		`python3 -c 'from pathlib import Path; Path("/tmp/verification-result.txt").write_text("ok")'`,
		"npm test > /tmp/verification-result.txt",
	])("allows recognized isolated write: %s", (command) => {
		expect(commandEffect(command, "/srv/project")).toMatchObject({ changesFiles: false, unknownChange: false });
		expect(isCheckCommand(run(command), "/srv/project")).toBe(true);
	});
	it.each([
		`node -e 'require("node:fs").writeFileSync(target, "ok")'`,
		`node -e 'require("node:fs").writeFileSync("/srv/project/app.js", "ok")'`,
		`node -e 'require("node:fs").writeFileSync("/tmp/../srv/project/app.js", "ok")'`,
		`node -e 'require("node:fs").writeFileSync("/tmp/result", "ok"); require("node:fs").writeFileSync(target, "bad")'`,
		"f=$(mktemp) && npm test > $f",
		"npm test > /dev/../srv/project/app.js",
		'npm test > "/srv/project/source file.js"',
		'npm test > "/tmp/$target"',
		`node.exe -e 'require("node:fs").writeFileSync("/srv/project/app.js", "bad")'`,
		"biome check --write .",
		"eslint --fix src",
		"ruff check --fix src",
		"prettier --write src",
		"black src",
		"gofmt -w app.go",
		"Set-Content -Path src/app.js -Value changed",
		"Add-Content src/app.js changed",
		"node tests/feature.mjs && Out-File -FilePath src/result.txt",
	])("keeps unknown/live/traversal writes invalidating: %s", (command) => {
		expect(commandEffect(command, "/srv/project").changesFiles).toBe(true);
	});
	it("does not mistake a /tmp worktree for artifact space", () => {
		const command = `node -e 'require("node:fs").writeFileSync("/tmp/project/app.js", "bad")'`;
		expect(commandEffect(command, "/tmp/project").changesFiles).toBe(true);
		expect(isCheckCommand(run(command), "/tmp/project")).toBe(false);
		expect(commandEffect(`cd /tmp/project && ${command}`, "/srv/project").changesFiles).toBe(true);
		expect(commandEffect(`cd "$WORKTREE" && ${command}`, "/srv/project").changesFiles).toBe(true);
	});
	it("keeps edits to previously edited external /tmp source invalidating", () => {
		const source = "/tmp/other-project/app.js";
		const command = `node -e 'require("node:fs").writeFileSync("${source}", "bad")'`;
		const messages = [...tool("edit", { path: source }), ...tool("bash", { command })];
		// A source-mutating command cannot serve as the post-edit check, even outside cwd.
		const plan: TaskPlan = {
			...create(),
			items: create().items.map((i) => (i.kind === "verify" ? { ...i, verifyCommand: command } : i)),
		};
		expect(close(plan, messages).error).toBeDefined();
	});
});

describe("actual runtime and claim-check regression", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verification-runtime-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	it.each(["--help", "-h", "--version", "-v"])(
		"rejects a real successful Node %s process as runtime evidence",
		(flag) => {
			const executed = spawnSync(process.execPath, [flag], { encoding: "utf8" });
			expect(executed.status).toBe(0);
			expect(executed.stdout.length).toBeGreaterThan(0);
			for (const name of ["bash", "powershell"]) {
				expect(isCheckCommand({ ...run(`node ${flag}`, name), output: executed.stdout })).toBe(false);
			}
			expect(() => create(`node ${flag}`)).toThrow(/runtime/);
		},
	);
	it("keeps help passed to an actual application script eligible because that script really executes", () => {
		const script = join(dir, "app.mjs");
		writeFileSync(script, 'console.log("application executed", process.argv.at(-1));\n');
		const executed = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
		expect(executed.status).toBe(0);
		expect(executed.stdout).toContain("application executed --help");
		expect(isCheckCommand(run(`node ${script} --help`))).toBe(true);
		expect(isCheckCommand(run("node --help && node tests/feature.mjs"))).toBe(true);
	});
	it("runs the changed module, writes an isolated artifact and captures real evidence", () => {
		const source = join(dir, "feature.mjs");
		const artifact = join(dir, "result.txt");
		writeFileSync(source, "export const answer = () => 42;\n");
		const code = `import assert from "node:assert/strict"; import { writeFileSync } from "node:fs"; import { answer } from ${JSON.stringify(source)}; assert.equal(answer(), 42); writeFileSync(${JSON.stringify(artifact)}, "feature PASS"); console.log("feature PASS");`;
		const command = `node --input-type=module -e '${code}'`;
		const executed = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
		expect(executed.status).toBe(0);
		expect(readFileSync(artifact, "utf8")).toBe("feature PASS");
		const messages = [...tool("edit", { path: source }), ...tool("bash", { command }, executed.stdout)];
		const result = close(create(command), messages);
		expect(result.error).toBeUndefined();
		expect(result.plan?.items[1].evidence?.output).toContain("feature PASS");
	});
	it("uses the real task_plan/write/bash tool factories and their configured cwd", async () => {
		let plan: TaskPlan | undefined;
		const messages: AgentMessage[] = [];
		const artifactDir = mkdtempSync(join(tmpdir(), "verification-artifacts-"));
		try {
			const source = join(dir, "feature.mjs");
			const artifact = join(artifactDir, "result.txt");
			const code = `import assert from "node:assert/strict"; import fs from "node:fs"; import { answer } from ${JSON.stringify(source)}; assert.equal(answer(), 42); fs.writeFileSync(${JSON.stringify(artifact)}, "tool pipeline PASS"); console.log("tool pipeline PASS");`;
			const command = `node --input-type=module -e '${code}'`;
			const planTool = wrapToolDefinition(
				createTaskPlanToolDefinition(
					{
						get: () => plan,
						set: (next) => {
							plan = next;
						},
						runMessages: () => messages,
					},
					dir,
				),
			);
			expect(planTool.parameters).toHaveProperty("properties.verify_command");
			await planTool.execute("create", {
				action: "create",
				goal: "g",
				items: ["source"],
				verify: "answer is 42",
				verify_command: command,
			});
			const written = await createWriteTool(dir).execute("write", {
				path: "feature.mjs",
				content: "export const answer = () => 42;\n",
			});
			messages.push(
				...tool(
					"write",
					{ path: "feature.mjs" },
					written.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
				),
			);
			const executed = await createBashTool(dir).execute("runtime", { command });
			messages.push(
				...tool("bash", { command }, executed.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")),
			);
			await planTool.execute("close", { action: "update", id: 2, status: "done" });
			expect(plan?.items[1].evidence?.output).toContain("tool pipeline PASS");
			expect(readFileSync(artifact, "utf8")).toBe("tool pipeline PASS");
			await planTool.execute("source-done", { action: "update", id: 1, status: "done" });
			// A literal /tmp write into this configured source cwd remains a source mutation.
			await expect(
				planTool.execute("bad", {
					action: "create",
					goal: "bad",
					verify: "bad",
					verify_command: `node -e 'require("node:fs").writeFileSync("${source}", "bad")'`,
				}),
			).rejects.toThrow(/runtime/);
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});
	it("rejects a genuine successful syntax check as proof of behavior without a plan", () => {
		const source = join(dir, "unrelated.mjs");
		writeFileSync(source, "export const value = 1;\n");
		const executed = spawnSync(process.execPath, ["--check", source], { encoding: "utf8" });
		expect(executed.status).toBe(0);
		const messages = [
			...tool("edit", { path: "feature.mjs" }),
			...tool("bash", { command: `node --check ${source}` }, executed.stdout),
			{ role: "assistant", content: [{ type: "text", text: "Tested and verified." }] } as AgentMessage,
		];
		expect(findClaimProblem(messages)).toContain("no check command");
	});
});
