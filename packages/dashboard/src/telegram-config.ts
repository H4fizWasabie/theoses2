import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BOT_TOKEN = "THEOSES_TELEGRAM_BOT_TOKEN";
const CHAT_ID = "THEOSES_TELEGRAM_CHAT_ID";

export interface TelegramConfigStatus {
	configured: boolean;
	ownerTelegramId: string | null;
}

interface TelegramConfigValues {
	botToken?: string;
	ownerTelegramId?: string;
}

async function readEnv(path: string): Promise<Map<string, string>> {
	const values = new Map<string, string>();
	try {
		const source = await readFile(path, "utf8");
		for (const line of source.split("\n")) {
			const separator = line.indexOf("=");
			if (separator < 1) continue;
			const key = line.slice(0, separator).trim();
			if (/^[A-Z_][A-Z0-9_]*$/.test(key)) values.set(key, line.slice(separator + 1).trim());
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return values;
}

function envSource(values: Map<string, string>): string {
	return `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function readTelegramValues(path: string): Promise<TelegramConfigValues> {
	const values = await readEnv(path);
	return {
		botToken: values.get(BOT_TOKEN) || process.env[BOT_TOKEN] || undefined,
		ownerTelegramId: values.get(CHAT_ID) || process.env[CHAT_ID] || undefined,
	};
}

export async function telegramConfigStatus(path: string): Promise<TelegramConfigStatus> {
	const values = await readTelegramValues(path);
	return {
		configured: Boolean(values.botToken && values.ownerTelegramId),
		ownerTelegramId: values.ownerTelegramId ?? null,
	};
}

export async function saveTelegramConfig(
	path: string,
	input: { botToken?: string; ownerTelegramId?: string },
): Promise<void> {
	const current = await readTelegramValues(path);
	const botToken = input.botToken?.trim() || current.botToken;
	const ownerTelegramId = input.ownerTelegramId?.trim() || current.ownerTelegramId;
	if (!botToken) throw new Error("bot token is required");
	if (!ownerTelegramId || !/^-?[1-9]\d*$/.test(ownerTelegramId)) {
		throw new Error("owner Telegram ID must be a numeric ID");
	}

	const values = await readEnv(path);
	values.set(BOT_TOKEN, botToken);
	values.set(CHAT_ID, ownerTelegramId);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${randomUUID()}`;
	await writeFile(temporary, envSource(values), { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}
