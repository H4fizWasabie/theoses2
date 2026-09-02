import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import lockfile from "proper-lockfile";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import {
	APP_NAME,
	detectInstallMethod,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
	VERSION,
} from "./config.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./utils/child-process.ts";
import { canonicalizePath, getCwdRelativePath } from "./utils/paths.ts";
import { getPiUserAgent } from "./utils/pi-user-agent.ts";
import { formatVersionCheckError, getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";

export type UpdateCommand = "update";

type UpdateTarget = { type: "self" } | { type: "models" };

const DEFAULT_INSTALLER_API_BASE = "https://pi.dev/api/installer/releases";
const MANAGED_INSTALL_MARKER = "managed-install.json";
const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function getActiveManagedInstallRoot(): string | undefined {
	const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
	if (!configuredRoot) return undefined;

	const managedRoot = resolve(configuredRoot);
	const releasesDir = canonicalizePath(join(managedRoot, "releases"));
	// The launcher environment is inherited by child processes. Do not classify a
	// source checkout or another Pi installation launched from managed Pi as managed.
	if (getCwdRelativePath(canonicalizePath(getPackageDir()), releasesDir) === undefined) return undefined;

	const markerPath = join(managedRoot, MANAGED_INSTALL_MARKER);
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
			kind?: unknown;
			layout?: unknown;
			schemaVersion?: unknown;
		};
		if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
			throw new Error();
		}
	} catch {
		throw new Error(`Managed install marker is missing or invalid: ${markerPath}`);
	}

	return managedRoot;
}

async function fetchInstallerArtifact(url: string, label: string): Promise<string> {
	const response = await fetch(url, { headers: { "User-Agent": getPiUserAgent(VERSION) } });
	if (!response.ok) {
		throw new Error(`Could not download managed installer ${label} from ${url}: HTTP ${response.status}`);
	}
	return await response.text();
}

async function runManagedNpmCi(stageDir: string): Promise<void> {
	const args = [
		"ci",
		"--ignore-scripts",
		"--min-release-age=0",
		"--omit=dev",
		"--include=optional",
		"--no-fund",
		"--no-audit",
		"--loglevel=error",
		"--progress=false",
	];
	const code = await waitForChildProcess(spawnProcess("npm", args, { cwd: stageDir, stdio: "inherit" }));
	if (code !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${code ?? "unknown"}`);
}

function verifyManagedRelease(releaseDir: string, expectedVersion: string): void {
	const binPath = join(
		releaseDir,
		"node_modules",
		".bin",
		process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME,
	);
	const result = spawnProcessSync(binPath, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Could not verify managed Pi ${expectedVersion}: ${reason}`);
	}
	const installedVersion = result.stdout.trim();
	if (installedVersion !== expectedVersion) {
		throw new Error(`Managed Pi smoke test returned version ${installedVersion}; expected ${expectedVersion}.`);
	}
}

function activateManagedRelease(managedRoot: string, version: string): void {
	const currentPath = join(managedRoot, "current-version");
	const temporaryPath = join(managedRoot, `current-version.tmp.${process.pid}-${Date.now()}`);
	try {
		writeFileSync(temporaryPath, `${version}\n`);
		renameSync(temporaryPath, currentPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function cleanupManagedStaging(managedRoot: string): void {
	const stagingRoot = join(managedRoot, "staging");
	try {
		for (const entry of readdirSync(stagingRoot)) {
			if (entry.startsWith("update-")) {
				rmSync(join(stagingRoot, entry), { force: true, recursive: true });
			}
		}
	} catch {
		// The staging directory does not exist yet or is not writable.
	}
}

export function cleanupManagedInstall(): void {
	let managedRoot: string | undefined;
	try {
		managedRoot = getActiveManagedInstallRoot();
	} catch {
		return;
	}
	if (!managedRoot) return;

	try {
		const releaseLock = lockfile.lockSync(join(managedRoot, "update"), { realpath: false });
		try {
			cleanupManagedStaging(managedRoot);
		} finally {
			releaseLock();
		}
	} catch {
		// A live update owns the staging directory, or cleanup is unavailable.
	}
}

async function runManagedSelfUpdate(managedRoot: string, version: string): Promise<void> {
	if (!MANAGED_RELEASE_VERSION_RE.test(version)) {
		throw new Error(`Invalid managed release version: ${version}`);
	}

	let releaseLock: () => Promise<void>;
	try {
		releaseLock = await lockfile.lock(join(managedRoot, "update"), { realpath: false });
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error("Another managed Pi update is already running.");
		}
		throw error;
	}

	let stageDir: string | undefined;
	try {
		cleanupManagedStaging(managedRoot);
		const installerApiBase = (process.env.PI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(
			/\/+$/,
			"",
		);
		const releaseUrl = `${installerApiBase}/${encodeURIComponent(version)}`;
		const stagingRoot = join(managedRoot, "staging");
		const releasesRoot = join(managedRoot, "releases");
		mkdirSync(releasesRoot, { recursive: true });
		const releaseDir = join(releasesRoot, version);
		if (existsSync(releaseDir)) {
			verifyManagedRelease(releaseDir, version);
			activateManagedRelease(managedRoot, version);
			return;
		}

		mkdirSync(stagingRoot, { recursive: true });
		stageDir = mkdtempSync(join(stagingRoot, "update-"));
		const [packageJsonContent, packageLockContent] = await Promise.all([
			fetchInstallerArtifact(`${releaseUrl}/package.json`, "package.json"),
			fetchInstallerArtifact(`${releaseUrl}/package-lock.json`, "package-lock.json"),
		]);
		writeFileSync(join(stageDir, "package.json"), packageJsonContent);
		writeFileSync(join(stageDir, "package-lock.json"), packageLockContent);

		await runManagedNpmCi(stageDir);
		verifyManagedRelease(stageDir, version);
		renameSync(stageDir, releaseDir);
		activateManagedRelease(managedRoot, version);
	} finally {
		if (stageDir) rmSync(stageDir, { force: true, recursive: true });
		await releaseLock();
	}
}

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

interface UpdateCommandOptions {
	command: UpdateCommand;
	updateTarget?: UpdateTarget;
	force: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getUpdateCommandUsage(): string {
	return `${APP_NAME} update [--models] [--force]`;
}

function printUpdateCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${getUpdateCommandUsage()}

Update pi or refresh model catalogs.

Options:
  --self                  Update pi only (default when no target is given)
  --models                Refresh model catalogs only
  --force                 Reinstall pi even if the current version is latest

Short forms:
  ${APP_NAME} update                Update pi only
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update pi             Update pi only (self works as alias to pi)
`);
}

function parseUpdateCommand(args: string[]): UpdateCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	if (rawCommand !== "update") return undefined;
	const command: UpdateCommand = "update";

	let force = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let selfFlag = false;
	let modelsFlag = false;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "--self") {
			selfFlag = true;
			continue;
		}

		if (arg === "--models") {
			modelsFlag = true;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		invalidArgument = invalidArgument ?? arg;
	}

	if (modelsFlag && (selfFlag || force)) conflictingOptions = "--models cannot be combined with --self or --force";
	const updateTarget: UpdateTarget = modelsFlag ? { type: "models" } : { type: "self" };

	return {
		command,
		updateTarget,
		force,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "self";
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

function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = PACKAGE_NAME,
): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageTarget));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of ${APP_NAME} executable: ${entrypoint}`);
	}
}

function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

function printPnpmSelfUpdateMetadataHint(): void {
	console.error(chalk.yellow("If pnpm reports missing package versions, its cached registry metadata may be stale."));
	console.error(chalk.yellow(`Run \`pnpm store prune\` and retry \`${APP_NAME} update --self\`.`));
}

function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	shouldRun: boolean;
	note?: string;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	try {
		latestRelease = await getLatestPiRelease(VERSION, { retry: true });
	} catch (error: unknown) {
		throw new Error(`Could not determine latest ${APP_NAME} version: ${formatVersionCheckError(error)}`, {
			cause: error,
		});
	}
	if (!latestRelease) {
		throw new Error(`Could not determine latest ${APP_NAME} version.`);
	}

	const packageName = latestRelease.packageName ?? PACKAGE_NAME;
	const installSpec = `${packageName}@${latestRelease.version}`;
	if (force || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
		return {
			packageName,
			installSpec,
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			shouldRun: true,
		};
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

export interface UpdateCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: InlineExtension[];
}): Promise<CommandSettingsResult> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const projectTrustWarnings: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		return { settingsManager, projectTrustWarnings };
	}

	const appMode = getCommandAppMode();
	const extensionsResult =
		options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

export async function handleUpdateCommand(
	args: string[],
	runtimeOptions: UpdateCommandRuntimeOptions = {},
): Promise<boolean> {
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

	if (options.command === "update" && options.updateTarget?.type === "models") {
		try {
			await refreshModelCatalogs(getAgentDir());
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown model catalog refresh error";
			console.error(chalk.red(`Error: ${message}`));
			process.exitCode = 1;
		}
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		useSavedProjectTrustOnly: true,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	reportSettingsErrors(settingsManager, "update command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	try {
		switch (options.command) {
			case "update": {
				const target = options.updateTarget ?? { type: "self" };
				if (updateTargetIncludesSelf(target)) {
					const managedInstallRoot = getActiveManagedInstallRoot();
					if (managedInstallRoot && options.force) {
						console.error(
							chalk.red(
								`Managed ${APP_NAME} installations do not support --force; rerun the installer to repair this installation.`,
							),
						);
						process.exitCode = 1;
						return true;
					}
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						return true;
					}
					if (managedInstallRoot) {
						if (selfUpdatePlan.note) {
							printSelfUpdateNote(selfUpdatePlan.note);
						}
						try {
							console.log(chalk.dim(`Updating managed ${APP_NAME} installation...`));
							await runManagedSelfUpdate(managedInstallRoot, selfUpdatePlan.version);
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : "Unknown managed update error";
							console.error(chalk.red(`Error: ${message}`));
							process.exitCode = 1;
							return true;
						}
						console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
						return true;
					}

					const installMethod = detectInstallMethod();
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						console.error(
							chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`),
						);
						console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
						process.exitCode = 1;
						return true;
					}
					const selfUpdateTarget = {
						packageName: selfUpdatePlan.packageName,
						installSpec: selfUpdatePlan.installSpec,
					};
					const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, selfUpdateNpmCommand, selfUpdateTarget);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdateTarget);
						process.exitCode = 1;
						return true;
					}
					if (selfUpdatePlan.note) {
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					try {
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown update command error";
						console.error(chalk.red(`Error: ${message}`));
						if (installMethod === "pnpm") {
							printPnpmSelfUpdateMetadataHint();
						}
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown update command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
