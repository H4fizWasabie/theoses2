import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

export interface MemoryRecord {
	id: string;
	createdAt: string;
	text: string;
}

export interface MemoryStore {
	remember(query: string): MemoryRecord[];
	saveNote(text: string): MemoryRecord;
}

function defaultMemoryPath(): string {
	return process.env.PI_MEMORY_FILE ?? join(homedir(), CONFIG_DIR_NAME, "memory.jsonl");
}

export class FileMemoryStore implements MemoryStore {
	private readonly filePath: string;

	constructor(filePath = defaultMemoryPath()) {
		this.filePath = filePath;
	}

	remember(query: string): MemoryRecord[] {
		if (!existsSync(this.filePath)) return [];
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return readFileSync(this.filePath, "utf8")
			.split("\n")
			.flatMap((line) => {
				try {
					const record = JSON.parse(line) as MemoryRecord;
					return typeof record.text === "string" && terms.every((term) => record.text.toLowerCase().includes(term))
						? [record]
						: [];
				} catch {
					return [];
				}
			})
			.slice(-8)
			.reverse();
	}

	saveNote(text: string): MemoryRecord {
		const record: MemoryRecord = { id: randomUUID(), createdAt: new Date().toISOString(), text: text.trim() };
		mkdirSync(dirname(this.filePath), { recursive: true });
		appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
		return record;
	}
}
