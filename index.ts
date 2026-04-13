import { copyToClipboard, CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Mode = "normal" | "insert";
type Pending = "d" | "c" | "y" | "f" | "F" | "t" | "T" | "r" | undefined;
type LastFind = { char: string; forward: boolean; till: boolean } | undefined;
type Cursor = { line: number; col: number };
type CustomEditorArgs = ConstructorParameters<typeof CustomEditor>;

type InternalEditor = {
	state: {
		cursorLine: number;
		lines?: string[];
		cursorCol?: number;
	};
	setCursorCol(col: number): void;
	onChange?: (text: string) => void;
	preferredVisualCol?: number | null;
	historyIndex?: number;
	lastAction?: string | null;
};

type EditorSnapshot = {
	text: string;
	cursor: Cursor;
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

function isBlankLine(text: string, offset: number): boolean {
	const start = lineStart(text, offset);
	const end = lineEnd(text, offset);
	return /^\s*$/.test(text.slice(start, end));
}

function paragraphForward(text: string, offset: number): number {
	let pos = lineEnd(text, offset);
	while (pos < text.length) {
		pos += 1;
		if (pos >= text.length) return lineStart(text, text.length);
		if (!isBlankLine(text, pos) && (pos === 0 || isBlankLine(text, pos - 1))) return pos;
		pos = lineEnd(text, pos);
	}
	return offset;
}

function paragraphBackward(text: string, offset: number): number {
	let pos = lineStart(text, offset);
	while (pos > 0) {
		pos = lineStart(text, pos - 1);
		if (!isBlankLine(text, pos) && (pos === 0 || isBlankLine(text, pos - 1))) return pos;
	}
	return 0;
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
	private pendingTextObject?: "i" | "a";
	private pendingFindOp?: { op: "d" | "c" | "y"; motion: "f" | "F" | "t" | "T" };
	private count = "";
	private pendingG = false;
	private lastFind: LastFind;
	private readonly redoStack: EditorSnapshot[] = [];
	private unnamedRegister = "";

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
		this.pendingTextObject = undefined;
		this.pendingFindOp = undefined;
		this.pendingG = false;
		this.count = "";
	}

	private takeCount(defaultCount = 1): number {
		const value = this.count ? Number.parseInt(this.count, 10) : defaultCount;
		this.count = "";
		return Number.isFinite(value) && value > 0 ? value : defaultCount;
	}

	private captureSnapshot(): EditorSnapshot {
		const cursor = this.getCursor();
		return {
			text: this.getText(),
			cursor: { line: cursor.line, col: cursor.col },
		};
	}

	private restoreSnapshot(snapshot: EditorSnapshot): void {
		this.editor.state.lines = snapshot.text.split("\n");
		this.editor.state.cursorLine = snapshot.cursor.line;
		this.editor.setCursorCol(snapshot.cursor.col);
		this.editor.preferredVisualCol = null;
		this.editor.historyIndex = -1;
		this.editor.lastAction = null;
		this.editor.onChange?.(snapshot.text);
		this.tui.requestRender();
	}

	private clearRedoStack(): void {
		this.redoStack.length = 0;
	}

	private writeRegister(text: string): void {
		this.unnamedRegister = text;
		void copyToClipboard(text).catch(() => {});
	}

	private wordObjectRange(around: boolean): { start: number; end: number } | undefined {
		const text = this.getCurrentText();
		let start = this.getCurrentOffset();
		if (!isWord(text[start])) {
			if (isWord(text[start - 1])) start -= 1;
			else return undefined;
		}
		while (start > 0 && isWord(text[start - 1])) start--;
		let end = start;
		while (end < text.length && isWord(text[end])) end++;
		if (around) {
			while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
		}
		return { start, end };
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

		this.clearRedoStack();
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

	private moveWord(direction: "next" | "prev" | "end", big: boolean, count = 1): void {
		this.moveToOffset(this.wordMotionTarget(direction, big, count));
	}

	private moveLeft(count = 1): void {
		let offset = this.getCurrentOffset();
		const text = this.getCurrentText();
		for (let i = 0; i < count; i++) {
			offset = Math.max(lineStart(text, offset), prevGraphemeOffset(text, offset));
		}
		this.moveToOffset(offset);
	}

	private moveRight(count = 1): void {
		let offset = this.getCurrentOffset();
		const text = this.getCurrentText();
		for (let i = 0; i < count; i++) {
			offset = Math.min(lineLast(text, offset), nextGraphemeOffset(text, offset));
		}
		this.moveToOffset(offset);
	}

	private moveUp(count = 1): void {
		let offset = this.getCurrentOffset();
		for (let i = 0; i < count; i++) {
			offset = moveUp(this.getCurrentText(), offset);
		}
		this.moveToOffset(offset);
	}

	private moveDown(count = 1): void {
		let offset = this.getCurrentOffset();
		for (let i = 0; i < count; i++) {
			offset = moveDown(this.getCurrentText(), offset);
		}
		this.moveToOffset(offset);
	}

	private moveLineStart(): void {
		this.moveToOffset(lineStart(this.getCurrentText(), this.getCurrentOffset()));
	}

	private moveLineFirstNonWhitespace(count = 1): void {
		if (count > 1) this.moveDown(count - 1);
		this.moveToOffset(firstNonWhitespace(this.getCurrentText(), this.getCurrentOffset()));
	}

	private moveToLine(lineNumber: number): void {
		const lines = this.getLines();
		const lineIndex = clamp(lineNumber - 1, 0, Math.max(0, lines.length - 1));
		const col = Math.min(this.getCursor().col, Math.max(0, (lines[lineIndex] ?? "").length - 1));
		this.setCursor(lineIndex, Math.max(0, col));
	}

	private moveParagraph(forward: boolean, count = 1): void {
		let offset = this.getCurrentOffset();
		for (let i = 0; i < count; i++) {
			offset = forward ? paragraphForward(this.getCurrentText(), offset) : paragraphBackward(this.getCurrentText(), offset);
		}
		this.moveToOffset(offset);
	}

	private moveLineEnd(): void {
		this.moveToOffset(lineLast(this.getCurrentText(), this.getCurrentOffset()));
	}

	private replaceUnderCursor(char: string, count = 1): void {
		this.clearPending();
		this.edit((text, offset) => {
			if (offset >= lineEnd(text, offset)) return undefined;
			let end = offset;
			for (let i = 0; i < count; i++) {
				end = nextGraphemeOffset(text, end);
				if (end > lineEnd(text, offset)) {
					end = lineEnd(text, offset);
					break;
				}
			}
			return {
				text: replaceRange(text, offset, end, char.repeat(Math.max(1, count))),
				cursorOffset: offset,
			};
		});
	}

	private deleteToLineEnd(change: boolean): void {
		this.clearPending();
		this.edit((text, offset) => {
			const end = lineEnd(text, offset);
			if (offset > end) return undefined;
			const deleteEnd = offset === end && end < text.length ? end + 1 : end;
			if (deleteEnd <= offset) return undefined;
			this.writeRegister(text.slice(offset, deleteEnd));
			return {
				text: replaceRange(text, offset, deleteEnd),
				cursorOffset: offset,
			};
		});
		if (change) this.setMode("insert");
	}

	private substituteChar(): void {
		this.clearPending();
		this.edit((text, offset) => {
			if (offset >= lineEnd(text, offset)) return undefined;
			const end = nextGraphemeOffset(text, offset);
			this.writeRegister(text.slice(offset, end));
			return {
				text: replaceRange(text, offset, end),
				cursorOffset: offset,
			};
		});
		this.setMode("insert");
	}

	private deleteUnderCursor(count = 1): void {
		this.clearPending();
		this.edit((text, offset) => {
			if (offset >= lineEnd(text, offset)) return undefined;
			let end = offset;
			for (let i = 0; i < count; i++) {
				end = nextGraphemeOffset(text, end);
				if (end > lineEnd(text, offset)) {
					end = lineEnd(text, offset);
					break;
				}
			}
			this.writeRegister(text.slice(offset, end));
			return {
				text: replaceRange(text, offset, end),
				cursorOffset: offset,
			};
		});
	}

	private applyRange(start: number, end: number, change = false, yank = false): void {
		this.clearPending();
		const from = Math.min(start, end);
		const to = Math.max(start, end);
		if (to <= from) return;
		const text = this.getCurrentText();
		this.writeRegister(text.slice(from, to));
		if (yank) {
			this.moveToOffset(start <= end ? from : Math.max(from, to - 1));
			return;
		}
		this.edit(() => ({
			text: replaceRange(text, from, to),
			cursorOffset: from,
		}));
		if (change) this.setMode("insert");
	}

	private wordMotionTarget(direction: "next" | "prev" | "end", big: boolean, count: number, from = this.getCurrentOffset()): number {
		let target = from;
		for (let i = 0; i < count; i++) {
			const text = this.getCurrentText();
			target =
				direction === "next"
					? nextWordStart(text, target, big)
					: direction === "prev"
						? prevWordStart(text, target, big)
						: wordEnd(text, target, big);
		}
		return target;
	}

	private deleteWord(change: boolean): void {
		const offset = this.getCurrentOffset();
		const endOffset = this.wordMotionTarget("next", false, this.takeCount(1), offset);
		this.applyRange(offset, endOffset, change);
	}

	private deleteLine(count = 1, direction: -1 | 1 | 0 = 0): void {
		this.clearPending();
		this.edit((text, offset) => {
			if (text.length === 0) return undefined;
			const { start, end } = this.lineBlockRange(count, direction);
			this.writeRegister(text.slice(start, end));
			const nextText = replaceRange(text, start, end);
			return {
				text: nextText,
				cursorOffset: Math.min(start, nextText.length),
			};
		});
	}

	private substituteLine(count = 1): void {
		this.deleteLine(count);
		this.setMode("insert");
	}

	private lineBlockRange(count: number, direction: -1 | 1 | 0): { start: number; end: number } {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		let start = lineStart(text, offset);
		let end = lineEnd(text, offset);
		if (direction >= 0) {
			for (let i = 1; i < count; i++) {
				if (end >= text.length) break;
				end = lineEnd(text, end + 1);
			}
			end = Math.min(end + 1, text.length);
		} else {
			for (let i = 1; i < count; i++) {
				if (start === 0) break;
				start = lineStart(text, start - 1);
			}
			end = Math.min(lineEnd(text, offset) + 1, text.length);
		}
		return { start, end };
	}

	private yankLine(count = 1): void {
		this.clearPending();
		const { start, end } = this.lineBlockRange(count, 0);
		this.writeRegister(this.getCurrentText().slice(start, end));
	}

	private put(after: boolean, count = 1): void {
		this.clearPending();
		if (!this.unnamedRegister) return;
		const register = this.unnamedRegister.repeat(Math.max(1, count));
		this.edit((text, offset) => {
			if (register.endsWith("\n")) {
				const insertAt = after ? lineEnd(text, offset) + (lineEnd(text, offset) < text.length ? 1 : 0) : lineStart(text, offset);
				const nextText = replaceRange(text, insertAt, insertAt, register);
				return { text: nextText, cursorOffset: insertAt };
			}

			const insertAt = after ? Math.min(nextGraphemeOffset(text, offset), text.length) : offset;
			const nextText = replaceRange(text, insertAt, insertAt, register);
			return {
				text: nextText,
				cursorOffset: Math.max(insertAt, insertAt + register.length - 1),
			};
		});
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

	private repeatFind(reverse = false): void {
		if (!this.lastFind) return;
		this.findChar(this.lastFind.char, reverse ? !this.lastFind.forward : this.lastFind.forward, this.lastFind.till);
	}

	private findCharTarget(char: string, forward: boolean, till = false): number | undefined {
		const text = this.getCurrentText();
		const offset = this.getCurrentOffset();
		const start = lineStart(text, offset);
		const end = lineEnd(text, offset);

		if (forward) {
			for (let i = offset + 1; i < end; i++) {
				if (text[i] === char) return till ? i - 1 : i;
			}
			return undefined;
		}

		for (let i = offset - 1; i >= start; i--) {
			if (text[i] === char) return till ? i + 1 : i;
		}
	}

	private findChar(char: string, forward: boolean, till = false): void {
		this.lastFind = { char, forward, till };
		const target = this.findCharTarget(char, forward, till);
		if (target !== undefined) this.moveToOffset(target);
	}

	private isInterruptKey(data: string): boolean {
		return (this as unknown as { keybindings: { matches(data: string, action: string): boolean } }).keybindings.matches(
			data,
			"app.interrupt",
		) || matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
	}

	private performUndo(): void {
		const before = this.captureSnapshot();
		super.handleInput("\x1f");
		const after = this.captureSnapshot();
		if (after.text !== before.text || after.cursor.line !== before.cursor.line || after.cursor.col !== before.cursor.col) {
			this.redoStack.push(before);
		}
	}

	private performRedo(): void {
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		this.restoreSnapshot(snapshot);
	}

	private applyPendingOperator(target: number, inclusive = false): boolean {
		const offset = this.getCurrentOffset();
		const change = this.pending === "c";
		const yank = this.pending === "y";
		this.applyRange(offset, inclusive ? target + 1 : target, change, yank);
		return true;
	}

	private handlePendingFindOp(data: string): boolean {
		if (!this.pendingFindOp || !(data.length === 1 && data.charCodeAt(0) >= 32)) return false;
		const target = this.findCharTarget(data, this.pendingFindOp.motion === "f" || this.pendingFindOp.motion === "t", this.pendingFindOp.motion === "t" || this.pendingFindOp.motion === "T");
		if (target === undefined) {
			this.clearPending();
			return true;
		}
		this.pending = this.pendingFindOp.op;
		const inclusive = this.pendingFindOp.motion === "f" || this.pendingFindOp.motion === "F";
		this.pendingFindOp = undefined;
		return this.applyPendingOperator(target, inclusive);
	}

	private handleTextObject(data: string): boolean {
		if (data !== "w" || !this.pendingTextObject || !this.pending) {
			this.clearPending();
			return false;
		}
		const range = this.wordObjectRange(this.pendingTextObject === "a");
		if (!range) {
			this.clearPending();
			return true;
		}
		const change = this.pending === "c";
		const yank = this.pending === "y";
		this.applyRange(range.start, range.end, change, yank);
		return true;
	}

	private handlePending(data: string): boolean {
		if (this.isInterruptKey(data)) {
			this.clearPending();
			this.tui.requestRender();
			return true;
		}

		switch (this.pending) {
			case "r": {
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					this.replaceUnderCursor(data, this.takeCount(1));
					return true;
				}
				break;
			}
			case "y":
			case "d":
			case "c": {
				if (data === "f" || data === "F" || data === "t" || data === "T") {
					this.pendingFindOp = { op: this.pending, motion: data };
					return true;
				}
				if (data === this.pending) {
					const count = this.takeCount(1);
					if (this.pending === "y") this.yankLine(count);
					else if (this.pending === "d") this.deleteLine(count);
					else this.substituteLine(count);
					return true;
				}
				if (data === "w") return this.applyPendingOperator(this.wordMotionTarget("next", false, this.takeCount(1)));
				if (data === "e") return this.applyPendingOperator(this.wordMotionTarget("end", false, this.takeCount(1)), true);
				if (data === "b") return this.applyPendingOperator(this.wordMotionTarget("prev", false, this.takeCount(1)));
				if (data === "W") return this.applyPendingOperator(this.wordMotionTarget("next", true, this.takeCount(1)));
				if (data === "E") return this.applyPendingOperator(this.wordMotionTarget("end", true, this.takeCount(1)), true);
				if (data === "B") return this.applyPendingOperator(this.wordMotionTarget("prev", true, this.takeCount(1)));
				if (data === "$") return this.applyPendingOperator(lineEnd(this.getCurrentText(), this.getCurrentOffset()));
				if (data === "0") return this.applyPendingOperator(lineStart(this.getCurrentText(), this.getCurrentOffset()));
				if (data === "^") return this.applyPendingOperator(firstNonWhitespace(this.getCurrentText(), this.getCurrentOffset()));
				if (data === "_") {
					const count = this.takeCount(1);
					if (this.pending === "y") this.yankLine(count);
					else if (this.pending === "d") this.deleteLine(count);
					else this.substituteLine(count);
					return true;
				}
				if (data === "G") {
					const offset = this.getCurrentOffset();
					const start = lineStart(this.getCurrentText(), offset);
					const end = this.getCurrentText().length;
					this.clearPending();
					this.writeRegister(this.getCurrentText().slice(start, end));
					if (this.pending === "y") return true;
					this.edit(() => ({ text: replaceRange(this.getCurrentText(), start, end), cursorOffset: start }));
					if (this.pending === "c") this.setMode("insert");
					return true;
				}
				if (data === "j") {
					const count = this.takeCount(1);
					if (this.pending === "y") this.yankLine(count + 1);
					else if (this.pending === "d") this.deleteLine(count + 1, 1);
					else this.substituteLine(count + 1);
					return true;
				}
				if (data === "k") {
					const count = this.takeCount(1);
					if (this.pending === "y") {
						const { start, end } = this.lineBlockRange(count + 1, -1);
						this.writeRegister(this.getCurrentText().slice(start, end));
						this.clearPending();
					} else if (this.pending === "d") this.deleteLine(count + 1, -1);
					else this.deleteLine(count + 1, -1), this.setMode("insert");
					return true;
				}
				break;
			}
			case "f":
			case "F":
			case "t":
			case "T": {
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					const forward = this.pending === "f" || this.pending === "t";
					const till = this.pending === "t" || this.pending === "T";
					if (this.pendingTextObject) {
						this.clearPending();
						return true;
					}
					if (this.pending === "f" || this.pending === "F" || this.pending === "t" || this.pending === "T") {
						this.findChar(data, forward, till);
						this.clearPending();
						return true;
					}
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
			if (matchesKey(data, Key.shiftAlt("a")) || data === "\x1bA") {
				this.moveToOffset(lineEnd(this.getCurrentText(), this.getCurrentOffset()));
				return;
			}
			if (matchesKey(data, Key.shiftAlt("i")) || data === "\x1bI") {
				this.moveToOffset(lineStart(this.getCurrentText(), this.getCurrentOffset()));
				return;
			}
			if (matchesKey(data, Key.alt("o")) || data === "\x1bo") {
				this.openLineBelow();
				return;
			}
			if (matchesKey(data, Key.shiftAlt("o")) || data === "\x1bO") {
				this.openLineAbove();
				return;
			}
			super.handleInput(data);
			return;
		}

		if (this.pendingFindOp) {
			if (this.handlePendingFindOp(data)) return;
		}

		if (this.pendingTextObject) {
			if (this.handleTextObject(data)) return;
		}

		if (this.pending && this.handlePending(data)) {
			return;
		}

		if (this.pendingG) {
			if (data === "g") {
				const count = this.takeCount(1);
				this.pendingG = false;
				this.moveToLine(count);
				return;
			}
			this.pendingG = false;
		}

		if (data >= "0" && data <= "9" && (data !== "0" || this.count.length > 0)) {
			this.count += data;
			return;
		}

		switch (data) {
			case "u":
			case "\x1f": {
				const count = this.takeCount(1);
				for (let i = 0; i < count; i++) this.performUndo();
				return;
			}
			case "\x12": {
				const count = this.takeCount(1);
				for (let i = 0; i < count; i++) this.performRedo();
				return;
			}
			case "I":
				this.insertLineStart();
				return;
			case "A":
				this.appendLineEnd();
				return;
			case "h":
				this.moveLeft(this.takeCount(1));
				return;
			case "j":
				this.moveDown(this.takeCount(1));
				return;
			case "k":
				this.moveUp(this.takeCount(1));
				return;
			case "l":
				this.moveRight(this.takeCount(1));
				return;
			case "w":
				this.moveWord("next", false, this.takeCount(1));
				return;
			case "b":
				this.moveWord("prev", false, this.takeCount(1));
				return;
			case "e":
				this.moveWord("end", false, this.takeCount(1));
				return;
			case "W":
				this.moveWord("next", true, this.takeCount(1));
				return;
			case "B":
				this.moveWord("prev", true, this.takeCount(1));
				return;
			case "E":
				this.moveWord("end", true, this.takeCount(1));
				return;
			case "0":
				this.moveLineStart();
				this.count = "";
				return;
			case "^":
				this.moveLineFirstNonWhitespace();
				this.count = "";
				return;
			case "_":
				this.moveLineFirstNonWhitespace(this.takeCount(1));
				return;
			case "$":
				this.moveLineEnd();
				this.count = "";
				return;
			case "g":
				this.pendingG = true;
				return;
			case "G":
				this.moveToLine(this.takeCount(this.getLines().length));
				return;
			case "{":
				this.moveParagraph(false, this.takeCount(1));
				return;
			case "}":
				this.moveParagraph(true, this.takeCount(1));
				return;
			case "o":
				this.openLineBelow();
				return;
			case "O":
				this.openLineAbove();
				return;
			case "x":
				this.deleteUnderCursor(this.takeCount(1));
				return;
			case "s":
				this.substituteChar();
				return;
			case "D":
				this.deleteToLineEnd(false);
				return;
			case "C":
				this.deleteToLineEnd(true);
				return;
			case "r":
				this.pending = "r";
				return;
			case "p":
				this.put(true, this.takeCount(1));
				return;
			case "P":
				this.put(false, this.takeCount(1));
				return;
			case "Y":
				this.yankLine(this.takeCount(1));
				return;
			case ";":
				this.repeatFind(false);
				return;
			case ",":
				this.repeatFind(true);
				return;
			case "J":
				this.joinLines();
				return;
			case "S":
				this.substituteLine(this.takeCount(1));
				return;
			case "d":
				this.pending = "d";
				return;
			case "c":
				this.pending = "c";
				return;
			case "y":
				this.pending = "y";
				return;
			case "i":
				if (this.pending === "d" || this.pending === "c" || this.pending === "y") {
					this.pendingTextObject = "i";
					return;
				}
				this.enterInsert();
				return;
			case "a":
				if (this.pending === "d" || this.pending === "c" || this.pending === "y") {
					this.pendingTextObject = "a";
					return;
				}
				this.appendAfterCursor();
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
