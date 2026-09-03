import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import type { SettingsManager, ToolSourceSettings } from "../core/settings-manager.ts";

function getMcpCommandUsage(): string {
	return `${APP_NAME} mcp add <name> <url> [--header key=value ...]
  ${APP_NAME} mcp add-stdio <name> <command> [arg ...] [--env key=value ...]
  ${APP_NAME} mcp list
  ${APP_NAME} mcp remove <name>`;
}

function printMcpCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${getMcpCommandUsage()}

Manage MCP (Model Context Protocol) tool sources. "add" registers a server reachable
over HTTP; "add-stdio" spawns a local command and speaks MCP over its stdin/stdout.
Changes take effect the next time theoses starts; a running session does not pick
them up.

Commands:
  add <name> <url> [--header key=value ...]              Register an HTTP MCP server
  add-stdio <name> <command> [arg ...] [--env key=value ...]  Register a stdio MCP server
  list                                                    List registered MCP servers
  remove <name>                                           Remove a registered MCP server
`);
}

function parseKeyValueFlag(pair: string | undefined, flagName: string): [string, string] | undefined {
	const separatorIndex = pair?.indexOf("=") ?? -1;
	if (!pair || separatorIndex < 0) {
		console.error(chalk.red(`${flagName} must be key=value, got "${pair ?? ""}"`));
		return undefined;
	}
	return [pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1)];
}

function parseHeaderArgs(args: string[], startIndex: number): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	for (let index = startIndex; index < args.length; index++) {
		if (args[index] !== "--header") {
			console.error(chalk.red(`Unknown option "${args[index]}" for "${APP_NAME} mcp add".`));
			return undefined;
		}
		const pair = parseKeyValueFlag(args[++index], "--header");
		if (!pair) return undefined;
		headers[pair[0]] = pair[1];
	}
	return headers;
}

function parseStdioArgs(
	args: string[],
	startIndex: number,
): { commandArgs: string[]; env: Record<string, string> } | undefined {
	const commandArgs: string[] = [];
	const env: Record<string, string> = {};
	for (let index = startIndex; index < args.length; index++) {
		if (args[index] === "--env") {
			const pair = parseKeyValueFlag(args[++index], "--env");
			if (!pair) return undefined;
			env[pair[0]] = pair[1];
			continue;
		}
		commandArgs.push(args[index]);
	}
	return { commandArgs, env };
}

function describeToolSource(source: ToolSourceSettings): string {
	if (source.kind === "mcp-stdio") return `${source.name}\t${[source.command, ...(source.args ?? [])].join(" ")}`;
	return `${source.name}\t${source.url}`;
}

export async function handleMcpCommand(args: string[], settingsManager: SettingsManager): Promise<boolean> {
	if (args[0] !== "mcp") return false;
	const sub = args[1];

	if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
		printMcpCommandHelp();
		return true;
	}

	if (sub === "list") {
		const mcpSources = settingsManager
			.getToolSources()
			.filter((source) => source.kind === "mcp" || source.kind === "mcp-stdio");
		if (mcpSources.length === 0) {
			console.log("No MCP servers registered.");
			return true;
		}
		for (const source of mcpSources) console.log(describeToolSource(source));
		return true;
	}

	if (sub === "add") {
		const name = args[2];
		const url = args[3];
		if (!name || !url) {
			console.error(chalk.red(`Usage: ${APP_NAME} mcp add <name> <url> [--header key=value ...]`));
			process.exitCode = 1;
			return true;
		}
		const headers = parseHeaderArgs(args, 4);
		if (headers === undefined) {
			process.exitCode = 1;
			return true;
		}
		try {
			settingsManager.addToolSource({
				kind: "mcp",
				name,
				url,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			});
			console.log(chalk.green(`Registered MCP server "${name}". Restart theoses for it to take effect.`));
		} catch (error) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
			process.exitCode = 1;
		}
		return true;
	}

	if (sub === "add-stdio") {
		const name = args[2];
		const command = args[3];
		if (!name || !command) {
			console.error(chalk.red(`Usage: ${APP_NAME} mcp add-stdio <name> <command> [arg ...] [--env key=value ...]`));
			process.exitCode = 1;
			return true;
		}
		const parsed = parseStdioArgs(args, 4);
		if (parsed === undefined) {
			process.exitCode = 1;
			return true;
		}
		try {
			settingsManager.addToolSource({
				kind: "mcp-stdio",
				name,
				command,
				...(parsed.commandArgs.length > 0 ? { args: parsed.commandArgs } : {}),
				...(Object.keys(parsed.env).length > 0 ? { env: parsed.env } : {}),
			});
			console.log(chalk.green(`Registered MCP server "${name}". Restart theoses for it to take effect.`));
		} catch (error) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
			process.exitCode = 1;
		}
		return true;
	}

	if (sub === "remove") {
		const name = args[2];
		if (!name) {
			console.error(chalk.red(`Usage: ${APP_NAME} mcp remove <name>`));
			process.exitCode = 1;
			return true;
		}
		try {
			settingsManager.removeToolSource(name);
			console.log(chalk.green(`Removed MCP server "${name}". Restart theoses for it to take effect.`));
		} catch (error) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
			process.exitCode = 1;
		}
		return true;
	}

	console.error(chalk.red(`Unknown mcp command "${sub}". Use "${APP_NAME} mcp help".`));
	process.exitCode = 1;
	return true;
}
