/**
 * Markdown -> Telegram HTML formatting.
 * Telegram HTML mode supports <b> <i> <u> <s> <code> <pre> <a> <blockquote>
 * <tg-spoiler> - no tables or lists, so pipe tables render as aligned <pre>
 * and list items as bullet lines. Ported from Mino's telegram_format.go.
 */

const RE_FENCE = /```(\w*)\n([\s\S]*?)```/g;
const RE_HEADING = /^#{1,3}\s+(.+)$/;
const RE_BULLET = /^[-*]\s+(.+)$/;
const RE_INLINE_CODE = /`([^`\n]+)`/g;
const RE_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const RE_BOLD = /\*\*(.+?)\*\*/g;
const RE_ITALIC = /(^|[^*])\*([^*\n]+)\*/g; // single * pair, bold already consumed
const RE_UNDERLINE = /__([^_\n]+)__/g;
const RE_SPOILER = /\|\|(.+?)\|\|/g;
const RE_STRIKE = /~~(.+?)~~/g;
const RE_QUOTE = /^>\s?(.*)$/;
const RE_QUOTE_EXPANDABLE = /^>!\s?(.*)$/;
const RE_DIVIDER = /^\|[\s\-:|]+\|$/;
const RE_TAG = /<[^>]+>/g;

const STASH_MARK = (index: number) => `\x00STASH${index}\x00`;
const STASH_PATTERN = /\x00STASH(\d+)\x00/;

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Splits a reply on lines that are exactly "---" into separate messages. */
export function splitSections(reply: string): string[] {
	const sections: string[] = [];
	let current: string[] = [];
	const flush = () => {
		const text = current.join("\n").trim();
		if (text) sections.push(text);
		current = [];
	};
	for (const line of reply.split("\n")) {
		if (line.trim() === "---") {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();
	return sections.length > 0 ? sections : [""];
}

/** Groups consecutive >-lines into <blockquote> blocks (">!" is the expandable variant). */
function formatBlockquotes(text: string, put: (rendered: string) => string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let block: string[] = [];
	let expandable = false;
	const flush = () => {
		if (block.length === 0) return;
		const tag = expandable ? "<blockquote expandable>" : "<blockquote>";
		out.push(put(`${tag}${escapeHtml(block.join("\n"))}</blockquote>`));
		block = [];
		expandable = false;
	};
	for (const line of lines) {
		const expandableMatch = line.match(RE_QUOTE_EXPANDABLE);
		if (expandableMatch) {
			expandable = true;
			block.push(expandableMatch[1]);
			continue;
		}
		const quoteMatch = line.match(RE_QUOTE);
		if (quoteMatch) {
			block.push(quoteMatch[1]);
			continue;
		}
		flush();
		out.push(line);
	}
	flush();
	return out.join("\n");
}

/** Pads cells to column width, with a rule under the header row. */
function renderPipeTable(rows: string[]): string {
	const cells: string[][] = [];
	const widths: number[] = [];
	for (const row of rows) {
		const parts = row.split("|").slice(1, -1);
		const cleaned = parts.map((cell) => cell.trim().replaceAll(RE_TAG, ""));
		cleaned.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, [...cell].length);
		});
		cells.push(cleaned);
	}
	const lines: string[] = [];
	cells.forEach((row, rowIndex) => {
		lines.push(row.map((cell, i) => cell + " ".repeat(widths[i] - [...cell].length)).join("  "));
		if (rowIndex === 0 && cells.length > 1) {
			lines.push(widths.map((width) => "─".repeat(width)).join("  "));
		}
	});
	return `<pre>${lines.join("\n")}</pre>`;
}

/** Converts runs of |...| lines into aligned <pre> blocks. */
function formatPipeTables(text: string): string {
	const out: string[] = [];
	let table: string[] = [];
	const flush = () => {
		if (table.length > 0) out.push(renderPipeTable(table));
		table = [];
	};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1) {
			if (!RE_DIVIDER.test(trimmed)) table.push(trimmed);
			continue;
		}
		flush();
		out.push(line);
	}
	flush();
	return out.join("\n");
}

/** Converts markdown-ish LLM output to Telegram HTML. Order is load-bearing. */
export function formatTelegramHtml(reply: string, toolNames: string[] = []): string {
	const stash: string[] = [];
	const put = (rendered: string): string => {
		stash.push(rendered);
		return STASH_MARK(stash.length - 1);
	};

	// 1. Fenced code blocks out first - protected from escape and inline rules.
	let text = reply.replaceAll(RE_FENCE, (_match, lang: string, code: string) => {
		const opening = lang ? `<pre><code class="language-${lang}">` : "<pre><code>";
		return put(`${opening}${escapeHtml(code)}</code></pre>`);
	});

	// 2. Blockquotes, stashed before escaping so the tags survive.
	text = formatBlockquotes(text, put);

	// 3. Escape everything else.
	text = escapeHtml(text);

	// 4. Line pass: headings -> <b>, list items -> bullet.
	text = text
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			const heading = trimmed.match(RE_HEADING);
			if (heading) return `<b>${heading[1]}</b>`;
			const bullet = trimmed.match(RE_BULLET);
			if (bullet) return `• ${bullet[1]}`;
			return line;
		})
		.join("\n");

	// 5. Inline code stashed too, so bold/strike can't rewrite its content.
	text = text.replaceAll(RE_INLINE_CODE, (_match, code: string) => put(`<code>${code}</code>`));
	text = text.replaceAll(RE_LINK, '<a href="$2">$1</a>');
	text = text.replaceAll(RE_BOLD, "<b>$1</b>");
	text = text.replaceAll(RE_ITALIC, "$1<i>$2</i>");
	text = text.replaceAll(RE_UNDERLINE, "<u>$1</u>");
	text = text.replaceAll(RE_SPOILER, "<tg-spoiler>$1</tg-spoiler>");
	text = text.replaceAll(RE_STRIKE, "<s>$1</s>");

	// 6. Restore stashed fences, blockquotes, and inline code.
	let match: RegExpMatchArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: mirrors the single-pass restore loop
	while ((match = text.match(STASH_PATTERN))) {
		text = text.slice(0, match.index) + stash[Number(match[1])] + text.slice((match.index ?? 0) + match[0].length);
	}

	// 7. Pipe tables -> aligned <pre> (runs last: cells already inline-formatted).
	text = formatPipeTables(text);

	if (toolNames.length > 0) text += `\n\n<code>${toolNames.join(" → ")}</code>`;
	return text;
}

/**
 * Splits html into <=max-length chunks (Telegram's 4096 limit is in UTF-16
 * code units, same as JS string length) at the last close-tag boundary,
 * else the last newline, else a hard cut.
 */
export function chunkHtml(html: string, max: number): string[] {
	if (html.length <= max) return [html];

	const chunks: string[] = [];
	let position = 0;
	while (position < html.length) {
		const end = position + max;
		if (end >= html.length) {
			chunks.push(html.slice(position));
			break;
		}
		let safe = end;
		const window = html.slice(position, end);
		const tagIndex = window.lastIndexOf("</");
		if (tagIndex > 0) {
			const closeIndex = html.indexOf(">", position + tagIndex);
			if (closeIndex !== -1 && closeIndex < end) safe = closeIndex + 1;
		} else {
			const newlineIndex = window.lastIndexOf("\n");
			if (newlineIndex > 0) safe = position + newlineIndex + 1;
		}
		chunks.push(html.slice(position, safe));
		position = safe;
	}
	return chunks;
}
