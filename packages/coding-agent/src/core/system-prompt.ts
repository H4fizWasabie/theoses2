/**
 * System prompt construction and project context loading
 */

import { basename } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Bounded per-channel-session Working Note. */
	workingNote?: string;
	/** Capped live document artifact catalog for this channel session. */
	artifactCatalog?: string;
}

function injectWorkingNote(note: string | undefined): string {
	if (!note) return "";
	if (note.length <= 2000) return note;
	const head = 1000;
	return `${note.slice(0, head)}\n...\n${note.slice(-1000)}`;
}

const STRUCTURAL_SECTIONS = `<working_note_guidance>
The Working Note is a provisional model-written orientation for this channel session. Use the working_note tool only when a durable near-term orientation has changed; never treat it as authoritative over current evidence.
</working_note_guidance>

<remember_guidance>
Use remember proactively whenever a question touches the user, their setup, or their projects and durable memory might hold relevant context - don't wait for an explicit "recall this" request, and don't make the user repeat something already saved.
</remember_guidance>

<efficiency>
Batch independent tool calls in one turn and combine related shell steps with && - every call stays in context for several turns. Sequence calls only when one depends on an earlier result. Plan silently; do not narrate the plan. A bare greeting or check-in needs a reply, not an investigation.
</efficiency>

<no_blocking_waits>
Never use bash to block the current turn on the passage of time (e.g. sleep N && check-something, polling loops, or waiting out a future cron/scheduled job) in order to report back later in the same reply. A blocking wait holds up the entire conversation turn — on chat surfaces like Telegram, the user sees no response at all until the wait ends, even if it's several minutes. If something won't be ready until later, say so now and stop the turn (e.g. "I'll check back once the run finishes" or state when you expect it), and check it on the user's next message or a real scheduled/deferred mechanism — not a synchronous sleep inside this turn.
</no_blocking_waits>

<destructive_action_caution>
Before an action that's hard to reverse or reaches beyond this task — deleting data, force-pushing, dropping tables, killing unrelated processes, changing shared infrastructure — pause and confirm with the user first, even if a tool technically allows it.
</destructive_action_caution>`;

type ContextFile = { path: string; content: string };

function isPersonaFile({ path }: ContextFile): boolean {
	return basename(path).toLowerCase() === "theoses.md";
}

function getPersona(contextFiles: ContextFile[]): string {
	return contextFiles
		.filter(isPersonaFile)
		.map(({ content }) => `<persona>\n${content}\n</persona>`)
		.join("\n\n");
}

/** Persona files are already emitted as <persona>; only the remaining context files belong here. */
function getProjectContext(contextFiles: ContextFile[]): string {
	const projectFiles = contextFiles.filter((file) => !isPersonaFile(file));
	if (projectFiles.length === 0) return "";
	let section = "\n\n<project_context>\n\n";
	section += "Project-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of projectFiles) {
		section += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	section += "</project_context>\n";
	return section;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		workingNote,
		artifactCatalog,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const workingNoteSection = workingNote
		? `\n\n<working_note>\nEstablished by earlier turns; verify this note if it contradicts current evidence.\n${injectWorkingNote(workingNote)}\n</working_note>`
		: "";
	const artifactSection = artifactCatalog
		? `\n\n<document_artifacts>\n${artifactCatalog}\nUse convert_doc on a document path when you need its contents.\n</document_artifacts>`
		: "";
	const personaSection = getPersona(contextFiles);
	const structuralSections = `\n\n${STRUCTURAL_SECTIONS}`;

	if (customPrompt) {
		let prompt = customPrompt;
		if (personaSection) prompt += `\n\n${personaSection}`;
		prompt += structuralSections;

		if (appendSection) {
			prompt += appendSection;
		}
		prompt += workingNoteSection;
		prompt += artifactSection;

		// Append project context files
		prompt += getProjectContext(contextFiles);

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline(
			"Prefer grep/find/ls/read over bash for search and file operations; use bash only when no specialized tool covers the job",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are Theoses, a blended personal assistant and coding agent operating inside Theoses. Adapt to the user's current task while helping with conversation, research, file reading, command execution, editing, and writing.

Available tools:
${toolsList}

Guidelines:
${guidelines}

Theoses documentation (read only when the user asks about Theoses itself, its SDK, extensions, themes, skills, or TUI):
- Docs: ${docsPath} (README: ${readmePath}); examples: ${examplesPath}. Resolve docs/... and examples/... under these paths, not the current working directory
- Topic files under docs/: extensions.md, themes.md, skills.md, prompt-templates.md, tui.md, keybindings.md, sdk.md, custom-provider.md, models.md, environment-variables.md. Read the relevant file completely and follow its .md links before implementing`;

	if (appendSection) {
		prompt += appendSection;
	}
	if (personaSection) prompt += `\n\n${personaSection}`;
	prompt += structuralSections;
	prompt += workingNoteSection;
	prompt += artifactSection;

	// Append project context files
	prompt += getProjectContext(contextFiles);

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
