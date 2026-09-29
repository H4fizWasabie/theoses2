import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyFileRewind,
	describeRewindPlan,
	FILE_CHECKPOINT_ENTRY_TYPE,
	FileCheckpoints,
	MAX_CHECKPOINT_BYTES,
	planFileRewind,
	sweepCheckpoints,
} from "../src/core/file-checkpoints.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("file checkpoints", () => {
	let root: string;
	let workspace: string;
	let session: SessionManager;
	let checkpoints: FileCheckpoints;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "file-checkpoints-"));
		workspace = join(root, "ws");
		mkdirSync(workspace);
		session = SessionManager.create(workspace, join(root, "sessions"));
		checkpoints = new FileCheckpoints(session, workspace);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const file = (name: string) => join(workspace, name);
	const read = (name: string) => readFileSync(file(name), "utf8");

	/** A user turn in which each `[name, content]` is announced to the checkpoints, then written. */
	function turn(text: string, writes: Array<[string, string]> = []): string {
		const id = session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		for (const [name, content] of writes) {
			checkpoints.beforeToolCall("write", { path: name });
			writeFileSync(file(name), content);
		}
		return id;
	}

	const checkpointEntries = () =>
		session.getEntries().filter((e) => e.type === "custom" && e.customType === FILE_CHECKPOINT_ENTRY_TYPE);

	const rewindTo = (id: string) =>
		applyFileRewind(planFileRewind(session.getBranch(), id), session.getCheckpointDirectory());

	it("still rewinds after the session is branched into a new file", () => {
		writeFileSync(file("a.txt"), "v0");
		const first = turn("first", [["a.txt", "v1"]]);
		turn("second");
		session.createBranchedSession(session.getLeafId() as string);

		expect(rewindTo(first).restored).toEqual([file("a.txt")]);
		expect(read("a.txt")).toBe("v0");
	});

	it("saves a file's original once per user turn, however often the turn changes it", () => {
		writeFileSync(file("a.txt"), "v0");
		turn("first", [["a.txt", "v1"]]);
		checkpoints.beforeToolCall("edit", { path: "a.txt" });
		checkpoints.beforeToolCall("write", { path: "a.txt" });
		expect(checkpointEntries()).toHaveLength(1);

		turn("second", [["a.txt", "v2"]]);
		expect(checkpointEntries()).toHaveLength(2);
	});

	it("puts a file back to how it was before any earlier turn", () => {
		writeFileSync(file("a.txt"), "v0");
		const first = turn("first", [["a.txt", "v1"]]);
		const second = turn("second", [["a.txt", "v2"]]);

		expect(rewindTo(second).restored).toEqual([file("a.txt")]);
		expect(read("a.txt")).toBe("v1");

		rewindTo(first);
		expect(read("a.txt")).toBe("v0");
	});

	it("deletes a file the turn created, and restores one the turn deleted", () => {
		writeFileSync(file("old.txt"), "keep me");
		const id = turn("go", [["new.txt", "created"]]);
		checkpoints.beforeToolCall("bash", { command: "rm old.txt" });
		rmSync(file("old.txt"));

		const result = rewindTo(id);

		expect(result.deleted).toEqual([file("new.txt")]);
		expect(existsSync(file("new.txt"))).toBe(false);
		expect(read("old.txt")).toBe("keep me");
	});

	it("follows the paths a shell command is known to change, and reports one it cannot trace", () => {
		writeFileSync(file("a.txt"), "before");
		const id = turn("go");
		checkpoints.beforeToolCall("bash", { command: "sed -i 's/before/after/' a.txt" });
		writeFileSync(file("a.txt"), "after");
		checkpoints.beforeToolCall("bash", { command: "python3 - <<'EOF'\nopen('b.txt','w').write('x')\nEOF" });

		const plan = planFileRewind(session.getBranch(), id);
		expect(plan.untraced).toHaveLength(1);
		rewindTo(id);
		expect(read("a.txt")).toBe("before");
	});

	it("does not restore a file it never saved, and says why", () => {
		writeFileSync(file("big.bin"), Buffer.alloc(MAX_CHECKPOINT_BYTES + 1));
		const id = turn("go", [["big.bin", "small now"]]);

		const result = rewindTo(id);

		expect(result.restored).toEqual([]);
		expect(result.skipped).toEqual([{ path: file("big.bin"), reason: expect.stringContaining("larger than") }]);
		expect(read("big.bin")).toBe("small now");
	});

	it("stores identical originals once", () => {
		writeFileSync(file("a.txt"), "same");
		writeFileSync(file("b.txt"), "same");
		turn("go", [
			["a.txt", "x"],
			["b.txt", "y"],
		]);
		expect(readdirSync(session.getCheckpointDirectory())).toHaveLength(1);
	});

	it("leaves the conversation the model sees untouched", () => {
		writeFileSync(file("a.txt"), "v0");
		turn("go", [["a.txt", "v1"]]);
		expect(checkpointEntries()).toHaveLength(1);
		expect(session.buildSessionContext().messages.map((m) => m.role)).toEqual(["user"]);
	});

	it("does nothing for a session that is not persisted", () => {
		const memory = SessionManager.inMemory();
		const unsaved = new FileCheckpoints(memory, workspace);
		memory.appendMessage({ role: "user", content: "go", timestamp: 1 });
		writeFileSync(file("a.txt"), "v0");
		unsaved.beforeToolCall("write", { path: "a.txt" });
		expect(memory.getEntries().filter((e) => e.type === "custom")).toEqual([]);
	});

	it("refuses to plan a rewind to an entry that is not on the branch", () => {
		turn("go");
		expect(() => planFileRewind(session.getBranch(), "missing")).toThrow("not on the current branch");
	});

	it("keeps going when one file cannot be restored", () => {
		writeFileSync(file("a.txt"), "v0");
		writeFileSync(file("b.txt"), "w0");
		const id = turn("go", [
			["a.txt", "v1"],
			["b.txt", "w1"],
		]);
		const plan = planFileRewind(session.getBranch(), id);
		const damaged = plan.restore[0].hash as string;
		rmSync(join(session.getCheckpointDirectory(), damaged));

		const result = applyFileRewind(plan, session.getCheckpointDirectory());

		expect(result.failed).toHaveLength(1);
		expect(result.restored).toHaveLength(1);
	});
});

describe("sweeping old checkpoint bytes", () => {
	const DAY = 24 * 60 * 60 * 1000;
	let root: string;
	let workspace: string;
	let session: SessionManager;
	let checkpoints: FileCheckpoints;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "checkpoint-sweep-"));
		workspace = join(root, "ws");
		mkdirSync(workspace);
		session = SessionManager.create(workspace, join(root, "sessions"));
		checkpoints = new FileCheckpoints(session, workspace);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const blobs = () => readdirSync(session.getCheckpointDirectory());
	const ageBlobs = (days: number) => {
		const then = new Date(Date.now() - days * DAY);
		for (const name of blobs()) utimesSync(join(session.getCheckpointDirectory(), name), then, then);
	};

	/** One user turn that overwrites `a.txt`, so its previous content is checkpointed. */
	function overwrite(content: string) {
		session.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		checkpoints.beforeToolCall("write", { path: "a.txt" });
		writeFileSync(join(workspace, "a.txt"), content);
	}

	it("removes original bytes nobody has used for a month, and keeps recent ones", () => {
		writeFileSync(join(workspace, "a.txt"), "old original");
		overwrite("v1");
		ageBlobs(40);
		writeFileSync(join(workspace, "a.txt"), "fresh original");
		overwrite("v2");
		expect(blobs()).toHaveLength(2);

		const removed = sweepCheckpoints(session.getCheckpointDirectory());

		expect(removed).toBe(1);
		expect(blobs()).toHaveLength(1);
	});

	it("keeps a blob that a recent checkpoint reused", () => {
		writeFileSync(join(workspace, "a.txt"), "same original");
		overwrite("v1");
		ageBlobs(40);
		writeFileSync(join(workspace, "a.txt"), "same original");
		overwrite("v2");

		expect(sweepCheckpoints(session.getCheckpointDirectory())).toBe(0);
		expect(blobs()).toHaveLength(1);
	});

	it("leaves files that are not checkpoint blobs alone", () => {
		writeFileSync(join(workspace, "a.txt"), "original");
		overwrite("v1");
		const stray = join(session.getCheckpointDirectory(), "notes.txt");
		writeFileSync(stray, "not ours");
		ageBlobs(40);

		sweepCheckpoints(session.getCheckpointDirectory());

		expect(existsSync(stray)).toBe(true);
	});

	it("does nothing when the directory does not exist", () => {
		expect(sweepCheckpoints(join(root, "nowhere"))).toBe(0);
	});

	it("tells the user a rewind cannot restore a file whose original was swept", () => {
		writeFileSync(join(workspace, "a.txt"), "original");
		overwrite("v1");
		const first = session.getBranch().find((e) => e.type === "message");
		ageBlobs(40);
		sweepCheckpoints(session.getCheckpointDirectory());

		const result = applyFileRewind(
			planFileRewind(session.getBranch(), first?.id as string),
			session.getCheckpointDirectory(),
		);

		expect(result.restored).toEqual([]);
		expect(result.failed[0].error).toContain("no longer saved");
	});
});

describe("describeRewindPlan", () => {
	it("says so when nothing changed", () => {
		expect(describeRewindPlan({ restore: [], skipped: [], untraced: [] })).toBe(
			"No files changed since that message.",
		);
	});

	it("counts restores and deletions, and names what cannot be undone", () => {
		const text = describeRewindPlan({
			restore: [
				{ path: "/w/a", hash: "h1" },
				{ path: "/w/b", hash: "h2" },
				{ path: "/w/new", hash: null },
			],
			skipped: [{ path: "/w/big.bin", reason: "larger than 10485760 bytes" }],
			untraced: ["python3 make.py", "sh gen.sh"],
		});
		expect(text).toBe(
			[
				"Restore 2 files to how they were before.",
				"Delete 1 file created since then.",
				"Cannot restore 1 file: /w/big.bin (larger than 10485760 bytes).",
				"2 shell commands changed files in ways that cannot be undone.",
			].join("\n"),
		);
	});

	it("shortens a long list of files it cannot restore", () => {
		const skipped = ["a", "b", "c", "d", "e"].map((name) => ({ path: `/w/${name}`, reason: "not a regular file" }));
		expect(describeRewindPlan({ restore: [], skipped, untraced: [] })).toContain(", and 2 more.");
	});
});
