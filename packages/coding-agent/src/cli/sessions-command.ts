import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { externalizeSessionFile } from "../core/session-images.ts";

function getSessionsCommandUsage(): string {
	return `${APP_NAME} sessions externalize-images <session-file> [--dry-run] [--force]`;
}

function printSessionsCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${getSessionsCommandUsage()}

Maintain session logs.

Commands:
  externalize-images <session-file>   Move the image data inside a session log out into files beside it,
                                      leaving references. New sessions already work this way; this converts
                                      one written before that. The original is kept as
                                      <session-file>.pre-image-externalize.bak

Options:
  --dry-run   Count the images that would move, change nothing
  --force     Rewrite even if the file was modified in the last 30 seconds. Stop the service that writes
              the file first: lines it appends while this runs would be lost
`);
}

function formatBytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function handleSessionsCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "sessions") return false;
	const sub = args[1];

	if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
		printSessionsCommandHelp();
		return true;
	}
	if (sub !== "externalize-images") {
		console.error(chalk.red(`Unknown sessions command "${sub}". Usage: ${getSessionsCommandUsage()}`));
		process.exitCode = 1;
		return true;
	}

	let file: string | undefined;
	let dryRun = false;
	let force = false;
	for (const arg of args.slice(2)) {
		if (arg === "--dry-run") dryRun = true;
		else if (arg === "--force") force = true;
		else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option "${arg}". Usage: ${getSessionsCommandUsage()}`));
			process.exitCode = 1;
			return true;
		} else if (file === undefined) file = arg;
		else {
			console.error(chalk.red(`Unexpected argument "${arg}". Usage: ${getSessionsCommandUsage()}`));
			process.exitCode = 1;
			return true;
		}
	}
	if (!file) {
		console.error(chalk.red(`A session file is required. Usage: ${getSessionsCommandUsage()}`));
		process.exitCode = 1;
		return true;
	}

	try {
		const result = externalizeSessionFile(file, { dryRun, force });
		if (dryRun) {
			console.log(
				`${result.images} image(s) in ${file} would move out of the log (${formatBytes(result.bytesBefore)} now). Dry run: nothing was changed.`,
			);
		} else if (result.images === 0) {
			console.log("No inline images to move; the file was not changed.");
		} else {
			console.log(
				`Moved ${result.images} image(s) out of the log: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)}. Original kept at ${result.backupPath}`,
			);
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
