import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "./config.ts";
import { ModelRuntime } from "./core/model-runtime.ts";

export type UpdateCommand = "update";

interface UpdateCommandOptions {
	command: UpdateCommand;
	updateTarget: { type: "models" };
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function getUpdateCommandUsage(): string {
	return `${APP_NAME} update`;
}

function printUpdateCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${getUpdateCommandUsage()}

Refresh model catalogs.

Options:
  ${APP_NAME} update       Refresh model catalogs
`);
}

function parseUpdateCommand(args: string[]): UpdateCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	if (rawCommand !== "update") return undefined;
	const command: UpdateCommand = "update";

	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		invalidArgument = invalidArgument ?? arg;
	}

	return {
		command,
		updateTarget: { type: "models" },
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

async function refreshModelCatalogs(agentDir: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) {
			throw new Error("Model catalog refresh timed out.");
		}
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(`Could not refresh model catalogs: ${details}`);
		}
	} finally {
		clearTimeout(timeout);
	}
	console.log(chalk.green("Model catalogs refreshed"));
}

export async function handleUpdateCommand(args: string[]): Promise<boolean> {
	const options = parseUpdateCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printUpdateCommandHelp();
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getUpdateCommandUsage()}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getUpdateCommandUsage()}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getUpdateCommandUsage()}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getUpdateCommandUsage()}`));
		process.exitCode = 1;
		return true;
	}

	try {
		await refreshModelCatalogs(getAgentDir());
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown update command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
