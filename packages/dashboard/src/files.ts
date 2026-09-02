import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MAX_EDIT_BYTES = 4 * 1024 * 1024;

export interface FileNode {
	name: string;
	path: string;
	kind: "file" | "directory" | "symlink";
}

export interface TextFile {
	path: string;
	content: string;
	version: string;
}

export class FileConflictError extends Error {
	constructor() {
		super("File changed on disk; reload it before saving");
		this.name = "FileConflictError";
	}
}

function versionOf(metadata: { mtimeMs: number; size: number }): string {
	return `${metadata.mtimeMs}:${metadata.size}`;
}

async function fileVersion(path: string): Promise<string> {
	const metadata = await stat(resolve(path));
	return versionOf(metadata);
}

function kindOf(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): FileNode["kind"] {
	if (entry.isDirectory()) return "directory";
	if (entry.isSymbolicLink()) return "symlink";
	return "file";
}

export async function listDirectory(path: string): Promise<FileNode[]> {
	const directory = resolve(path);
	const entries = await readdir(directory, { withFileTypes: true });
	return entries
		.map((entry) => ({ name: entry.name, path: join(directory, entry.name), kind: kindOf(entry) }))
		.sort((left, right) => {
			if (left.kind === "directory" && right.kind !== "directory") return -1;
			if (left.kind !== "directory" && right.kind === "directory") return 1;
			return left.name.localeCompare(right.name);
		});
}

export async function readTextFile(path: string): Promise<TextFile> {
	const filePath = resolve(path);
	const metadata = await stat(filePath);
	if (!metadata.isFile()) throw new Error("Only regular files can be edited");
	if (metadata.size > MAX_EDIT_BYTES) throw new Error("File is larger than the 4 MiB editor limit");
	const bytes = await readFile(filePath);
	if (bytes.includes(0)) throw new Error("Binary files are not editable in the dashboard");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	return { path: filePath, content: decoder.decode(bytes), version: versionOf(metadata) };
}

export async function writeTextFile(path: string, content: string, expectedVersion: string): Promise<TextFile> {
	const filePath = resolve(path);
	const currentVersion = await fileVersion(filePath);
	if (currentVersion !== expectedVersion) throw new FileConflictError();
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length > MAX_EDIT_BYTES) throw new Error("File is larger than the 4 MiB editor limit");

	const temporaryDirectory = await mkdtemp(join(dirname(filePath), ".theoses-edit-"));
	const temporaryPath = join(temporaryDirectory, basename(filePath));
	try {
		await writeFile(temporaryPath, bytes, { mode: (await stat(filePath)).mode });
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
	return readTextFile(filePath);
}

export async function renamePath(path: string, newName: string): Promise<{ oldPath: string; newPath: string }> {
	const oldPath = resolve(path);
	if (!newName || newName === "." || newName === ".." || newName.includes("/") || newName.includes("\\")) {
		throw new Error("New name must be one non-empty path segment");
	}
	await stat(oldPath);
	const newPath = join(dirname(oldPath), newName);
	try {
		await stat(newPath);
		throw new Error("A file or folder with that name already exists");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			await rename(oldPath, newPath);
			return { oldPath, newPath };
		}
		throw error;
	}
}
