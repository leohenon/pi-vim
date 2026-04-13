import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Mode = "normal" | "insert";
type Pending = "d" | "c" | "f" | "F" | "t" | "T" | undefined;
type Cursor = { line: number; col: number };
type CustomEditorArgs = ConstructorParameters<typeof CustomEditor>;

type InternalEditor = {
	state: {
		cursorLine: number;
	};
	setCursorCol(col: number): void;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function isWord(char: string | undefined): boolean {
	return !!char && /[A-Za-z0-9_]/.test(char);
}

function isBigWord(char: string | undefined): boolean {
	return !!char && !/\s/.test(char);
}

function lineStart(text: string, offset: number): number {
	if (offset <= 0) return 0;
	const bounded = Math.min(offset, text.length);
	const index = text.lastIndexOf("\n", bounded - 1);
	return index === -1 ? 0 : index + 1;
}

function lineEnd(text: string, offset: number): number {
	const bounded = Math.min(Math.max(offset, 0), text.length);
	const index = text.indexOf("\n", bounded);
	return index === -1 ? text.length : index;
}

function lineLast(text: string, offset: number): number {
	const start = lineStart(text, offset);
	const end = lineEnd(text, offset);
	return end > start ? end - 1 : start;
}

function prevLineStart(text: string, offset: number): number | undefined {
	const start = lineStart(text, offset);
	if (start === 0) return undefined;
	return lineStart(text, start - 1);
}

function nextLineStart(text: string, offset: number): number | undefined {
	const end = lineEnd(text, offset);
	if (end >= text.length) return undefined;
	return end + 1;
}

function moveUp(text: string, offset: number): number {
	const currentStart = lineStart(text, offset);
	const targetStart = prevLineStart(text, offset);
	if (targetStart === undefined) return offset;
	const targetLast = lineLast(text, targetStart);
	const col = offset - currentStart;
	return Math.min(targetStart + col, targetLast);
}

function moveDown(text: string, offset: number): number {
	const currentStart = lineStart(text, offset);
	const targetStart = nextLineStart(text, offset);
	if (targetStart === undefined) return offset;
	const targetLast = lineLast(text, targetStart);
	const col = offset - currentStart;
	return Math.min(targetStart + col, targetLast);
}

function nextWordStart(text: string, offset: number, big: boolean): number {
	const match = big ? isBigWord : isWord;
	let pos = offset;

	if (pos < text.length && match(text[pos])) {
		while (pos < text.length && match(text[pos])) pos++;
	}
	while (pos < text.length && !match(text[pos])) pos++;
	return pos;
}

function prevWordStart(text: string, offset: number, big: boolean): number {
	const match = big ? isBigWord : isWord;
	let pos = offset;

	while (pos > 0 && !match(text[pos - 1])) pos--;
	while (pos > 0 && match(text[pos - 1])) pos--;
	return pos;
}

function wordEnd(text: string, offset: number, big: boolean): number {
	if (text.length === 0) return 0;

	const match = big ? isBigWord : isWord;
	let pos = offset;
	if (pos >= text.length) pos = text.length - 1;

	if (match(text[pos]) && (pos + 1 >= text.length || !match(text[pos + 1]))) {
		pos++;
	}

	while (pos < text.length && !match(text[pos])) pos++;
	if (pos >= text.length) return text.length - 1;

	while (pos + 1 < text.length && match(text[pos + 1])) pos++;
	return pos;
}

function firstNonWhitespace(text: string, offset: number): number {
	const start = lineStart(text, offset);
	const end = lineEnd(text, offset);
	let pos = start;
	while (pos < end && /\s/.test(text[pos] ?? "")) pos++;
	return pos;
}

function totalLength(lines: string[]): number {
	if (lines.length === 0) return 0;
	return lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1;
}

function cursorToOffset(lines: string[], cursor: Cursor): number {
	let offset = 0;
	for (let i = 0; i < cursor.line; i++) {
		offset += (lines[i] ?? "").length + 1;
	}
	return offset + cursor.col;
}

function offsetToCursor(lines: string[], offset: number): Cursor {
	const boundedOffset = clamp(offset, 0, totalLength(lines));
	let remaining = boundedOffset;

	for (let line = 0; line < lines.length; line++) {
		const current = lines[line] ?? "";
		if (remaining <= current.length) {
			return { line, col: remaining };
		}
		remaining -= current.length;
		if (line < lines.length - 1) remaining -= 1;
	}

	const lastLine = Math.max(0, lines.length - 1);
	return { line: lastLine, col: (lines[lastLine] ?? "").length };
}

function nextGraphemeOffset(text: string, offset: number): number {
	if (offset >= text.length) return offset;
	for (const segment of graphemeSegmenter.segment(text.slice(offset))) {
		return offset + segment.segment.length;
	}
	return Math.min(offset + 1, text.length);
}

function prevGraphemeOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	let previous = 0;
	for (const segment of graphemeSegmenter.segment(text.slice(0, offset))) {
		previous = segment.index;
	}
	return previous;
}

function replaceRange(text: string, start: number, end: number, replacement = ""): string {
	return text.slice(0, start) + replacement + text.slice(end);
}

class VimModeEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pending: Pending;

	constructor(
		tui: CustomEditorArgs[0],
		theme: CustomEditorArgs[1],
		keybindings: CustomEditorArgs[2],
		private onModeChange: (mode: Mode) => void,
	) {
		super(tui, theme, keybindings);
		this.onModeChange(this.mode);
	}

	private get editor(): InternalEditor {
		return this as unknown as InternalEditor;
	}

	private clearPending(): void {
		this.pending = undefined;
	}

	private setMode(mode: Mode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.onModeChange(mode);
		this.tui.requestRender();
	}

	private getCurrentText(): string {
		return this.getText();
	}

	private getCurrentOffset(): number {
		return cursorToOffset(this.getLines(), this.getCursor());
	}

	private setCursor(line: number, col: number): void {
		this.editor.state.cursorLine = line;
		this.editor.setCursorCol(col);
		this.tui.requestRender();
	}

	private moveToOffset(offset: number): void {
		const cursor = offsetToCursor(this.getLines(), offset);
		this.setCursor(cursor.line, cursor.col);
	}

	private normalizeCursorForNormalMode(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		if (line.length === 0) {
			this.setCursor(cursor.line, 0);
			return;
		}
		if (cursor.col > 0) {
			this.setCursor(cursor.line, Math.min(cursor.col - 1, line.length - 1));
			return;
		}
		this.setCursor(cursor.line, 0);
	}

	private edit(transform: (text: string, offset: number) => { text: string; cursorOffset: number } | undefined): boolean {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		const next = transform(text, offset);
		if (!next) return false;
		if (next.text === text && next.cursorOffset === offset) return false;

		this.setText(next.text);
		const cursor = offsetToCursor(this.getLines(), next.cursorOffset);
		this.setCursor(cursor.line, cursor.col);
		return true;
	}

	private enterInsert(): void {
		this.clearPending();
		this.setMode("insert");
	}

	private appendAfterCursor(): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		this.moveToOffset(Math.min(offset + 1, lineEnd(text, offset)));
		this.enterInsert();
	}

	private insertLineStart(): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		this.moveToOffset(firstNonWhitespace(text, offset));
		this.enterInsert();
	}

	private appendLineEnd(): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		this.moveToOffset(lineEnd(text, offset));
		this.enterInsert();
	}

	private openLineBelow(): void {
		this.clearPending();
		this.edit((text, offset) => {
			const at = lineEnd(text, offset);
			return {
				text: `${text.slice(0, at)}\n${text.slice(at)}`,
				cursorOffset: at + 1,
			};
		});
		this.setMode("insert");
	}

	private openLineAbove(): void {
		this.clearPending();
		this.edit((text, offset) => {
			const at = lineStart(text, offset);
			return {
				text: `${text.slice(0, at)}\n${text.slice(at)}`,
				cursorOffset: at,
			};
		});
		this.setMode("insert");
	}

	private moveWord(direction: "next" | "prev" | "end", big: boolean): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		const target =
			direction === "next"
				? nextWordStart(text, offset, big)
				: direction === "prev"
					? prevWordStart(text, offset, big)
					: wordEnd(text, offset, big);
		this.moveToOffset(target);
	}

	private moveLeft(): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		this.moveToOffset(Math.max(lineStart(text, offset), prevGraphemeOffset(text, offset)));
	}

	private moveRight(): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		this.moveToOffset(Math.min(lineLast(text, offset), nextGraphemeOffset(text, offset)));
	}

	private moveUp(): void {
		this.moveToOffset(moveUp(this.getCurrentText(), this.getCurrentOffset()));
	}

	private moveDown(): void {
		this.moveToOffset(moveDown(this.getCurrentText(), this.getCurrentOffset()));
	}

	private moveLineStart(): void {
		this.moveToOffset(lineStart(this.getCurrentText(), this.getCurrentOffset()));
	}

	private moveLineEnd(): void {
		this.moveToOffset(lineLast(this.getCurrentText(), this.getCurrentOffset()));
	}

	private deleteUnderCursor(): void {
		this.clearPending();
		this.edit((text, offset) => {
			if (offset >= lineEnd(text, offset)) return undefined;
			return {
				text: replaceRange(text, offset, nextGraphemeOffset(text, offset)),
				cursorOffset: offset,
			};
		});
	}

	private deleteWord(change: boolean): void {
		this.clearPending();
		this.edit((text, offset) => {
			const endOffset = nextWordStart(text, offset, false);
			if (endOffset <= offset) return undefined;
			return {
				text: replaceRange(text, offset, endOffset),
				cursorOffset: offset,
			};
		});
		if (change) this.setMode("insert");
	}

	private deleteLine(): void {
		this.clearPending();
		this.edit((text, offset) => {
			if (text.length === 0) return undefined;
			const start = lineStart(text, offset);
			const end = lineEnd(text, offset);

			if (end < text.length) {
				return {
					text: replaceRange(text, start, end + 1),
					cursorOffset: start,
				};
			}

			if (start > 0) {
				const nextText = replaceRange(text, start - 1, end);
				return {
					text: nextText,
					cursorOffset: lineStart(nextText, start - 1),
				};
			}

			return { text: "", cursorOffset: 0 };
		});
	}

	private substituteLine(): void {
		this.clearPending();
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		const start = lineStart(text, offset);
		const end = lineEnd(text, offset);

		if (end > start) {
			this.edit(() => ({
				text: replaceRange(text, start, end),
				cursorOffset: start,
			}));
		} else {
			this.moveToOffset(start);
		}

		this.setMode("insert");
	}

	private joinLines(): void {
		this.clearPending();
		this.edit((text, offset) => {
			const end = lineEnd(text, offset);
			if (end >= text.length) return undefined;

			let next = end + 1;
			while (next < text.length && (text[next] === " " || text[next] === "\t")) next++;

			const trailing = end > 0 && /[ \t]/.test(text[end - 1] ?? "");
			const paren = next < text.length && text[next] === ")";
			let nextText = replaceRange(text, end, next);
			if (!trailing && !paren) {
				nextText = replaceRange(nextText, end, end, " ");
			}

			return {
				text: nextText,
				cursorOffset: end,
			};
		});
	}

	private findChar(char: string, forward: boolean, till = false): void {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		const start = lineStart(text, offset);
		const end = lineEnd(text, offset);

		if (forward) {
			for (let i = offset + 1; i < end; i++) {
				if (text[i] === char) {
					this.moveToOffset(till ? i - 1 : i);
					return;
				}
			}
			return;
		}

		for (let i = offset - 1; i >= start; i--) {
			if (text[i] === char) {
				this.moveToOffset(till ? i + 1 : i);
				return;
			}
		}
	}

	private isInterruptKey(data: string): boolean {
		return (this as unknown as { keybindings: { matches(data: string, action: string): boolean } }).keybindings.matches(
			data,
			"app.interrupt",
		) || matchesKey(data, "escape");
	}

	private handlePending(data: string): boolean {
		if (this.isInterruptKey(data)) {
			this.clearPending();
			this.tui.requestRender();
			return true;
		}

		switch (this.pending) {
			case "d": {
				if (data === "d") {
					this.deleteLine();
					return true;
				}
				if (data === "w") {
					this.deleteWord(false);
					return true;
				}
				break;
			}
			case "c": {
				if (data === "c") {
					this.substituteLine();
					return true;
				}
				if (data === "w") {
					this.deleteWord(true);
					return true;
				}
				break;
			}
			case "f":
			case "F":
			case "t":
			case "T": {
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					this.findChar(data, this.pending === "f" || this.pending === "t", this.pending === "t" || this.pending === "T");
					this.clearPending();
					return true;
				}
				break;
			}
			default:
				return false;
		}

		const printable = data.length === 1 && data.charCodeAt(0) >= 32;
		this.clearPending();
		return printable;
	}

	handleInput(data: string): void {
		if (this.isInterruptKey(data)) {
			if (this.mode === "insert") {
				if (this.isShowingAutocomplete()) {
					super.handleInput(data);
				}
				this.clearPending();
				this.normalizeCursorForNormalMode();
				this.setMode("normal");
			} else if (this.pending) {
				this.clearPending();
				this.tui.requestRender();
			} else {
				super.handleInput(data);
			}
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		if (this.pending && this.handlePending(data)) {
			return;
		}

		switch (data) {
			case "u":
				super.handleInput("\x1f");
				return;
			case "i":
				this.enterInsert();
				return;
			case "I":
				this.insertLineStart();
				return;
			case "a":
				this.appendAfterCursor();
				return;
			case "A":
				this.appendLineEnd();
				return;
			case "h":
				this.moveLeft();
				return;
			case "j":
				this.moveDown();
				return;
			case "k":
				this.moveUp();
				return;
			case "l":
				this.moveRight();
				return;
			case "w":
				this.moveWord("next", false);
				return;
			case "b":
				this.moveWord("prev", false);
				return;
			case "e":
				this.moveWord("end", false);
				return;
			case "W":
				this.moveWord("next", true);
				return;
			case "B":
				this.moveWord("prev", true);
				return;
			case "E":
				this.moveWord("end", true);
				return;
			case "0":
				this.moveLineStart();
				return;
			case "$":
				this.moveLineEnd();
				return;
			case "o":
				this.openLineBelow();
				return;
			case "O":
				this.openLineAbove();
				return;
			case "x":
				this.deleteUnderCursor();
				return;
			case "J":
				this.joinLines();
				return;
			case "S":
				this.substituteLine();
				return;
			case "d":
				this.pending = "d";
				return;
			case "c":
				this.pending = "c";
				return;
			case "f":
				this.pending = "f";
				return;
			case "F":
				this.pending = "F";
				return;
			case "t":
				this.pending = "t";
				return;
			case "T":
				this.pending = "T";
				return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = "insert";
	let enabled = true;

	const applyVimMode = (ctx: ExtensionContext): void => {
		mode = "insert";

		if (!enabled) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							totalInput += entry.message.usage.input;
							totalOutput += entry.message.usage.output;
							totalCacheRead += entry.message.usage.cacheRead;
							totalCacheWrite += entry.message.usage.cacheWrite;
							totalCost += entry.message.usage.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					let pwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const prefix = mode === "insert" ? theme.fg("muted", "-- INSERT -- ") : "";
					const pwdLine = truncateToWidth(prefix + theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const contextPercentDisplay =
						contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
					const contextPart =
						contextPercentValue > 90
							? theme.fg("error", contextPercentDisplay)
							: contextPercentValue > 70
								? theme.fg("warning", contextPercentDisplay)
								: contextPercentDisplay;
					statsParts.push(contextPart);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx.model?.id || "no-model";
					const thinkingLevel = pi.getThinkingLevel();
					let rightSide =
						ctx.model?.reasoning && thinkingLevel !== "off"
							? `${modelName} • ${thinkingLevel}`
							: ctx.model?.reasoning
								? `${modelName} • thinking off`
								: modelName;

					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${rightSide}`;
						if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
							rightSide = withProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightSideWidth <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new VimModeEditor(tui, theme, keybindings, (nextMode) => {
					mode = nextMode;
				}),
		);
	};

	pi.registerCommand("vim-mode", {
		description: "Toggle vim mode",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			applyVimMode(ctx);
			ctx.ui.notify(`Vim mode ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		applyVimMode(ctx);
	});
}
