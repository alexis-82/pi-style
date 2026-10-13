import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NormalizedPiStyleConfig } from "../../domain/config-types.js";
import { contextPercent, type StatusSnapshot } from "../../domain/status.js";
import type { ResolvedTheme } from "../../domain/theme.js";
import { resolveTheme } from "../../domain/theme.js";
import { stripAnsi, truncateAnsi } from "../../shared/ansi.js";
import { clipboardMarkerAtEnd, isSingleClipboardImagePath } from "../../shared/clipboard-path.js";

export const EDITOR_DIAGNOSTIC_KEY = "pi-style.editor";
type SetEditorComponent = NonNullable<ExtensionUIContext["setEditorComponent"]>;
type EditorFactory = NonNullable<Parameters<SetEditorComponent>[0]>;
type Tui = Parameters<EditorFactory>[0];
type PiEditorTheme = Parameters<EditorFactory>[1];
type Keybindings = Parameters<EditorFactory>[2];
type EditorHost = Pick<ExtensionUIContext, "setEditorComponent"> & {
	getEditorComponent?: () => EditorFactory | undefined;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	/** Full Pi theme; semantic primary color and concrete color styling
	 *  (getColorMode/fg — Pi 1.2's optional Theme.style needs no augmentation
	 *  here; nothing in pi-style calls it directly). */
	readonly theme?: ExtensionUIContext["theme"];
};

export interface EditorInstallation {
	readonly generation: number;
	readonly installedFactory: EditorFactory;
	readonly previousFactory: EditorFactory | undefined;
	readonly preservedPrevious: boolean;
	update(snapshot: StatusSnapshot): void;
	configure(config: NormalizedPiStyleConfig): void;
	dispose(): void;
}

/** Structural clipboard-image paste surface (ADR 0009) consumed by the
 *  editor. Structural so this feature needs no cross-feature import; the
 *  app layer passes the instance built in features/messages. */
interface ClipboardImagePasteSurface {
	enabled(): boolean;
	clipboardHasImage(): boolean | null;
	markerFromClipboard(): string;
	markerFromArtifact(path: string): Promise<string>;
	isMarkerIndexRegistered(index: number): boolean;
	discardMarkerIndex(index: number): void;
}

interface EditorOptions {
	config: NormalizedPiStyleConfig;
	snapshot: StatusSnapshot;
	theme: PiEditorTheme;
	/** Full Pi theme for primary accent and concrete session color. */
	fullTheme?: EditorHost["theme"];
	onSnapshot: (snapshot: StatusSnapshot) => void;
	onDispose?: () => void;
	/** Clipboard image paste surface (ADR 0009): instant `[Image #N] ` markers
	 *  at keystroke time, artifact-path fallback, atomic marker backspace.
	 *  Undefined keeps native behavior entirely. */
	clipboardImagePaste?: ClipboardImagePasteSurface;
}

/** Pi-tui Editor internals mirrored for O(1) atomic marker surgery. All are
 *  runtime-present on the Editor prototype chain but TS-private; the typed
 *  cast follows the autocompleteState-access pattern used in render(). */
interface EditorInternals {
	readonly state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: string | null;
	readonly onChange?: (text: string) => void;
	exitHistoryBrowsing(): void;
	setCursorCol(col: number): void;
	cancelAutocomplete(): void;
}

interface RenderPlan {
	readonly style: "compact" | "boxed" | "dock" | "native";
	readonly kind: "compact" | "boxed" | "outline" | "rounded" | "native";
	readonly prompt: string;
	readonly promptWidth: number;
	readonly padding: number;
	readonly sideReserve: number;
	readonly renderWidth: number;
	readonly innerWidth: number;
	readonly prefix: string;
	readonly continuation: string;
}

const widthOf = visibleWidth;

/** Literal RGB colors are not theme tokens; respect the terminal's color mode. */
function rgbBorder(color: string, mode: "truecolor" | "256color"): (text: string) => string {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
	const [red = 0, green = 0, blue = 0] = channels;
	const cube = (value: number) => Math.round((value / 255) * 5);
	const code =
		mode === "256color" ? `38;5;${16 + 36 * cube(red) + 6 * cube(green) + cube(blue)}` : `38;2;${red};${green};${blue}`;
	return (text) => `\x1b[${code}m${text}\x1b[39m`;
}

function widthSafe(value: string, width: number): string {
	if (width <= 0) return "";
	const measured = widthOf(value);
	if (measured > width) {
		const fitted = truncateAnsi(value, width, "");
		const current = widthOf(fitted);
		return current < width ? fitted + " ".repeat(width - current) : fitted;
	}
	return measured < width ? value + " ".repeat(width - measured) : value;
}

function isNativeBorderLine(line: string): boolean {
	const stripped = stripAnsi(line);
	return /^─{2,}$/.test(stripped) || /^─── [↑↓] \d+ more /.test(stripped);
}

/**
 * Remove `count` leading visible characters from an ANSI-rendered editor line,
 * preserving escape sequences (CSI/OSC/APC/DCS) verbatim. Used to hide the
 * bash-mode `!` prefix; the CURSOR_MARKER and cursor-block sequences pass
 * through unchanged so hardware-cursor placement stays aligned.
 */
function stripLeadingVisibleChars(line: string, count: number): string {
	if (count <= 0 || line.length === 0) return line;
	let output = "";
	let stripped = 0;
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === "\x1b") {
			const start = index;
			index++;
			const intro = line[index];
			if (intro === "[") {
				index++;
				while (index < line.length) {
					const byte = line[index] ?? "";
					index++;
					if (byte >= "@" && byte <= "~") break;
				}
			} else if (intro === "]" || intro === "_" || intro === "^" || intro === "P") {
				index++;
				while (index < line.length) {
					const byte = line[index] ?? "";
					if (byte === "\x1b" && line[index + 1] === "\\") {
						index += 2;
						break;
					}
					index++;
					if (byte === "\x07") break;
				}
			} else if (intro !== undefined) {
				index++;
			}
			output += line.slice(start, index);
			continue;
		}
		if (stripped < count) {
			stripped++;
			index++;
			continue;
		}
		output += char;
		index++;
	}
	return output;
}

function semanticTheme(theme: PiEditorTheme, config: NormalizedPiStyleConfig): ResolvedTheme {
	const editorTheme = theme;
	return resolveTheme(
		{
			fg: (token) => {
				if (token === "borderActive" || token.startsWith("thinking")) return editorTheme.borderColor("");
				return "";
			},
		},
		config,
	);
}

/**
 * A thin CustomEditor treatment: all text, cursor, paste, autocomplete, history,
 * and keybinding state remains owned by Pi's editor implementation.
 */
export class StyledEditor extends CustomEditor implements EditorComponent {
	private config: NormalizedPiStyleConfig;
	private snapshot: StatusSnapshot;
	private readonly piTheme: PiEditorTheme;
	private readonly fullTheme: EditorOptions["fullTheme"];
	private readonly onSnapshot: (snapshot: StatusSnapshot) => void;
	private readonly onDispose: (() => void) | undefined;
	private semantic: ResolvedTheme;
	/** Set when config changes; invalidate() then rebuilds the (otherwise stable) semantic theme. */
	private semanticDirty = false;
	private disposed = false;
	private renderPlanCache: { key: string; plan: RenderPlan } | undefined;
	/** Scoped to one native render; never cache an animated/themed status line. */
	private nativeFrame: { width: number; kind: RenderPlan["kind"]; topBorder?: string } | undefined;
	private readonly clipboardImagePaste: ClipboardImagePasteSurface | undefined;
	/** Keybinding matcher (the factory's KeybindingsManager) for keystroke-level
	 *  interception: the paste keybinding and backspace checks below. */
	private readonly editorKeybindings: { matches(data: string, keybinding: string): boolean };

	constructor(tui: Tui, theme: PiEditorTheme, keybindings: Keybindings, options: EditorOptions) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.config = options.config;
		this.snapshot = options.snapshot;
		this.piTheme = theme;
		this.fullTheme = options.fullTheme;
		this.onSnapshot = options.onSnapshot;
		this.onDispose = options.onDispose;
		this.clipboardImagePaste = options.clipboardImagePaste;
		this.editorKeybindings = keybindings as unknown as { matches(data: string, keybinding: string): boolean };
		this.semantic = semanticTheme(theme, options.config);
		this.setPaddingX(0);
	}

	update(snapshot: StatusSnapshot): void {
		if (this.disposed) return;
		this.snapshot = snapshot;
		this.invalidate();
	}

	configure(config: NormalizedPiStyleConfig): void {
		if (this.disposed) return;
		this.config = config;
		this.semanticDirty = true;
		this.invalidate();
	}

	override handleInput(data: string): void {
		if (this.disposed) return;
		if (this.handleClipboardImagePasteKeystroke(data)) return;
		if (this.handleAtomicMarkerBackspace(data)) return;
		super.handleInput(data);
		this.onSnapshot({ ...this.snapshot });
	}

	/**
	 * Instant marker (ADR 0009): when the built-in paste keybinding fires, the
	 * clipboard holds an image (sync native probe), and the surface is enabled,
	 * the keystroke is owned here — an `[Image #N] ` marker is inserted
	 * immediately (zero-latency feedback) and the bytes fill the registry
	 * entry asynchronously. Pi's own paste handler never runs for this
	 * keystroke, so no temp artifact is written. Text pastes (no image) and
	 * probe-unavailable hosts fall through to the native path untouched.
	 */
	private handleClipboardImagePasteKeystroke(data: string): boolean {
		const surface = this.clipboardImagePaste;
		if (!surface?.enabled()) return false;
		if (!this.editorKeybindings.matches(data, "app.clipboard.pasteImage")) return false;
		if (surface.clipboardHasImage() !== true) return false;
		super.insertTextAtCursor(surface.markerFromClipboard());
		this.onSnapshot({ ...this.snapshot });
		return true;
	}

	/**
	 * Atomic marker backspace (ADR 0009): backspacing directly after a
	 * registered `[Image #N] ` marker deletes the whole marker as one unit —
	 * the image is discarded (image-paste semantics). Direct state surgery
	 * (O(1)) mirroring pi-tui's handleBackspace mutation protocol: no setText
	 * round-trip (it clears the pastes registry, and undo snapshots store that
	 * Map by reference — silently breaking `[paste #N]` atomicity on undo) and
	 * no per-column left-arrow inputs (O(K·L) through the keybinding chain and
	 * visual line maps). No undo snapshot is pushed: the discarded image
	 * cannot be restored, so the deletion is intentionally non-undoable.
	 */
	private handleAtomicMarkerBackspace(data: string): boolean {
		const surface = this.clipboardImagePaste;
		if (!surface?.enabled()) return false;
		const isBackspace = this.editorKeybindings.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f";
		if (!isBackspace) return false;
		const lines = this.getLines();
		const cursor = this.getCursor();
		const current = lines[cursor.line];
		if (current === undefined) return false;
		const before = current.slice(0, cursor.col);
		const hit = clipboardMarkerAtEnd(before);
		if (!hit || !surface.isMarkerIndexRegistered(hit.index)) return false;
		const editor = this as unknown as EditorInternals;
		const targetCol = cursor.col - hit.length;
		editor.exitHistoryBrowsing();
		editor.lastAction = null;
		editor.cancelAutocomplete();
		// Splice the marker out of its line in place (deletion never removes a
		// line, so cursorLine is unchanged). setCursorCol also clears
		// preferredVisualCol/snappedFromCursorCol. scrollOffset is left alone;
		// render() re-clamps it to keep the cursor visible.
		editor.state.lines[cursor.line] = current.slice(0, targetCol) + current.slice(cursor.col);
		editor.setCursorCol(targetCol);
		editor.onChange?.(this.getText());
		surface.discardMarkerIndex(hit.index);
		this.invalidate();
		this.onSnapshot({ ...this.snapshot });
		return true;
	}

	/**
	 * Artifact-path fallback (ADR 0009): when the keystroke was not owned
	 * (probe unavailable, native editor path, config toggled) Pi's built-in
	 * paste still inserts a `<tmpdir>/pi-clipboard-<uuid>.<ext>` path through
	 * this method. Convert it to a marker when the artifact reads successfully;
	 * every failure inserts the original text verbatim (exact native behavior).
	 */
	override insertTextAtCursor(text: string): void {
		const surface = this.clipboardImagePaste;
		if (!surface?.enabled() || !isSingleClipboardImagePath(text)) {
			super.insertTextAtCursor(text);
			return;
		}
		void (async () => {
			let replacement = text;
			try {
				replacement = await surface.markerFromArtifact(text);
			} catch {
				// Unreadable artifact or surface failure: keep native behavior.
			}
			super.insertTextAtCursor(replacement);
			// The caller (Pi's handleClipboardPaste) requested its render before
			// this async insert completed — without a repaint the marker stays
			// invisible until the next keystroke. Request one now.
			this.tui.requestRender();
		})();
	}

	override invalidate(): void {
		super.invalidate();
		// The semantic theme is derived from (piTheme, config); piTheme is fixed per
		// instance and config changes go through configure(), so keystroke-driven
		// invalidations reuse the cached instance instead of rebuilding it.
		if (this.semanticDirty) {
			this.semantic = semanticTheme(this.piTheme, this.config);
			this.semanticDirty = false;
		}
		this.renderPlanCache = undefined;
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const plan = this.renderPlan(width);
		const autocompleteState = (this as unknown as { autocompleteState?: unknown }).autocompleteState;
		if (plan.style === "native") return super.render(width).map((line) => widthSafe(line, width));
		if (autocompleteState) return this.renderAutocompleteFrame(width, plan);

		const innerLines = this.renderNativeFrame(plan.innerWidth, width, plan.kind);
		if (innerLines.length === 0) return [];
		const body = innerLines.slice(1, -1);
		const hint = this.config.editor.hint;
		const showHint = hint !== "" && this.getText() === "";
		const bashHidden = this.bashHiddenCount();
		const renderedBody = body.map((line, index) => {
			const lead = index === 0 ? plan.prefix : plan.continuation;
			const source = index === 0 && bashHidden > 0 ? stripLeadingVisibleChars(line, bashHidden) : line;
			let content = `${lead}${source}`;
			if (showHint && index === 0 && line) {
				let end = content.length;
				while (end > 0 && content[end - 1] === " ") end--;
				if (end < content.length) content = content.slice(0, end);
				content += this.semantic.apply("hint", hint);
			}
			return widthSafe(content, plan.renderWidth);
		});
		const metadata = this.metadata(width, plan.style);
		const framed = this.frame(width, plan.style, renderedBody, metadata, innerLines[0] ?? "");
		return framed.map((line) => widthSafe(line, width));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose?.();
		this.invalidate();
	}

	private renderPlan(width: number): RenderPlan {
		const style = this.styleFor(width);
		const prompt = this.prompt();
		const kind = this.frameKind(style);
		const key = `${width}:${style}:${kind}:${prompt}`;
		if (this.renderPlanCache?.key === key) return this.renderPlanCache.plan;
		const promptWidth = widthOf(prompt) + 1;
		const padding = this.paddingFor(width, style);
		const sideReserve = kind === "rounded" ? 2 : 0;
		const renderWidth = Math.max(1, width - sideReserve);
		const innerWidth = Math.max(1, renderWidth - promptWidth - padding * 2);
		const prefix = `${" ".repeat(padding)}${prompt} `;
		const continuation = " ".repeat(padding + promptWidth);
		const plan = {
			style,
			kind,
			prompt,
			promptWidth,
			padding,
			sideReserve,
			renderWidth,
			innerWidth,
			prefix,
			continuation,
		};
		this.renderPlanCache = { key, plan };
		return plan;
	}

	/**
	 * Pi supplies the live indicator and scroll count through its protected
	 * border hook. Render it at the FRAME width, not the narrower text width,
	 * so padding/prompt decoration cannot truncate a status that still fits.
	 */
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const frame = this.nativeFrame;
		if (!frame) return this.borderColor(stripAnsi(super.renderTopBorder(width, hiddenLineCount)));
		const borderWidth = this.topBorderWidth(frame.width, frame.kind);
		// Pi owns spinner/scroll composition; the entire top border shares our
		// session color, including indicator text that Pi colors independently.
		const previousBorderColor = this.borderColor;
		let nativeBorder: string;
		try {
			this.borderColor = this.borderColorFor();
			nativeBorder = this.borderColor(stripAnsi(super.renderTopBorder(borderWidth, hiddenLineCount)));
		} finally {
			this.borderColor = previousBorderColor;
		}
		frame.topBorder = this.styleTopBorder(frame.width, frame.kind, nativeBorder);
		return frame.topBorder;
	}

	private topBorderWidth(width: number, kind: RenderPlan["kind"]): number {
		return Math.max(0, width - (kind === "rounded" || kind === "outline" ? 2 : 0));
	}

	private styleTopBorder(width: number, kind: RenderPlan["kind"], nativeBorder?: string): string {
		const border = this.borderFor();
		const borderWidth = this.topBorderWidth(width, kind);
		const glyph = kind === "boxed" ? (this.config.editor.frame === "halfblock" ? "▀" : "━") : "─";
		// Only reshape an empty native rule. Preserve status/scroll text and
		// geometry; never parse a message or read Pi's private indicator.
		const label = this.snapshot.sessionName
			? [...stripAnsi(this.snapshot.sessionName)]
					.map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
					.join("")
					.trim()
			: undefined;
		let content =
			nativeBorder !== undefined && !/^─*$/.test(stripAnsi(nativeBorder))
				? nativeBorder
				: border(glyph.repeat(borderWidth));
		if (label && borderWidth > 12) {
			// Reserve room for the native working indicator and scroll label. Never
			// truncate their content just to display the session name.
			const plain = stripAnsi(content);
			const trailing = plain.match(/[─━▀]+$/u)?.[0] ?? "";
			const maxLabel = Math.min(visibleWidth(label), Math.floor(borderWidth / 2), borderWidth - 8);
			const title = truncateToWidth(label, maxLabel, "…");
			const suffixWidth = visibleWidth(title) + 3;
			if (trailing.length >= suffixWidth) {
				// Reverse the frame foreground over the terminal's default background:
				// a solid frame-colored badge with contrasting terminal-background text.
				// Close reverse video before drawing the remaining rule/corner.
				const badge = border(`\x1b[49m\x1b[7m ${title} \x1b[27m`);
				content = truncateToWidth(content, borderWidth - suffixWidth, "") + badge + border(glyph);
			}
		}
		if (kind === "rounded") return `${border("╭")}${content}${border("╮")}`;
		if (kind === "outline") return `${border("┌")}${content}${border("┐")}`;
		return content;
	}

	private frameBottomBorder(width: number, kind: RenderPlan["kind"]): string {
		const border = this.borderFor();
		const inner = this.topBorderWidth(width, kind);
		if (kind === "rounded") return border(`╰${"─".repeat(inner)}╯`);
		if (kind === "outline") return border(`└${"─".repeat(inner)}┘`);
		const glyph = kind === "boxed" ? (this.config.editor.frame === "halfblock" ? "▀" : "━") : "─";
		return border(glyph.repeat(width));
	}

	private renderNativeFrame(nativeWidth: number, frameWidth: number, kind: RenderPlan["kind"]): string[] {
		const previous = this.nativeFrame;
		const frame: NonNullable<StyledEditor["nativeFrame"]> = { width: frameWidth, kind };
		this.nativeFrame = frame;
		try {
			const lines = super.render(nativeWidth);
			// Older Pi editors may not call the border hook. Retain our idle frame;
			// their host still owns the standalone working indicator above it.
			if (lines.length > 0) lines[0] = frame.topBorder ?? this.styleTopBorder(frameWidth, kind);
			return lines;
		} finally {
			this.nativeFrame = previous;
		}
	}

	private renderAutocompleteFrame(width: number, plan: RenderPlan): string[] {
		const nativeLines = this.renderNativeFrame(width, width, plan.kind);
		const borderIndex = nativeLines.slice(1).findIndex((line) => isNativeBorderLine(line));
		const split = borderIndex >= 0 ? borderIndex + 1 : nativeLines.length;
		const body = nativeLines.slice(1, split);
		const dropdown = nativeLines.slice(split);
		const sideColor = plan.kind === "rounded" ? this.borderColorFor() : undefined;
		const wrap = (line: string) =>
			plan.kind === "rounded" && sideColor ? `${sideColor("│")}${line}${sideColor("│")}` : line;
		const bashHidden = this.bashHiddenCount();
		const renderedBody = body.map((line, index) => {
			const source = index === 0 && bashHidden > 0 ? stripLeadingVisibleChars(line, bashHidden) : line;
			return wrap(widthSafe(`${index === 0 ? plan.prefix : plan.continuation}${source}`, plan.renderWidth));
		});
		const dropdownLines = dropdown.map((line) => wrap(widthSafe(line, plan.renderWidth)));
		return [nativeLines[0] ?? "", ...renderedBody, ...dropdownLines, this.frameBottomBorder(width, plan.kind)];
	}

	private prompt(): string {
		if (this.isBashMode()) {
			// Bash mode (`!` prefix): the prompt glyph becomes the bash icon and the
			// leading `!` is hidden from the input text. The glyph takes the live
			// border color (pi sets editor.borderColor to the bashMode color).
			const glyph = this.semantic.glyph("bashPrompt");
			return this.borderColorFor()(glyph);
		}
		const configured = this.config.theme.glyphs.prompt;
		if (configured) return configured;
		return this.semantic.mode === "ascii" ? ">" : "❯";
	}

	/** Pi's bash mode: the input starts with `!` after optional whitespace. */
	private isBashMode(): boolean {
		return this.getText().trimStart().startsWith("!");
	}

	/**
	 * Number of leading `!` characters to hide from the displayed input while
	 * bash mode is active. Characters under the cursor are never hidden, so the
	 * native cursor block stays visible when the cursor sits on a `!`.
	 */
	private bashHiddenCount(): number {
		const text = this.getText();
		let index = 0;
		while (index < text.length && (text[index] === " " || text[index] === "\t")) index++;
		const runStart = index;
		while (index < text.length && text[index] === "!") index++;
		const run = index - runStart;
		if (run === 0) return 0;
		const cursor = this.getCursor();
		const position = cursor.line === 0 ? cursor.col : Number.POSITIVE_INFINITY;
		return Math.min(run, Math.max(0, position - runStart));
	}

	private styleFor(width: number): "compact" | "boxed" | "dock" | "native" {
		if (width < 20) return "native";
		if (["compact", "boxed", "dock", "native"].includes(this.config.editor.style)) {
			if (this.config.editor.style === "native") return "native";
			if (width < 40 && this.config.editor.style !== "compact") return "compact";
			return this.config.editor.style as "compact" | "boxed" | "dock";
		}
		return "compact";
	}

	/**
	 * Resolve the frame treatment for a style: horizontal bars for compact,
	 * full-width bars for boxed, an outlined box for dock, and a rounded box
	 * with side borders (`╭─╮ │ │ ╰─╯`) for `frame: "rounded"`.
	 */
	private frameKind(
		style: "compact" | "boxed" | "dock" | "native",
	): "compact" | "boxed" | "outline" | "rounded" | "native" {
		const frame = this.config.editor.frame;
		if (style === "compact" || frame === "line" || frame === "solid") return "compact";
		if (style === "boxed") return "boxed";
		if (frame === "native") return "native";
		if (frame === "rounded") return "rounded";
		return "outline";
	}

	private paddingFor(width: number, style: "compact" | "boxed" | "dock" | "native"): number {
		if (width < 50) return 0;
		return style === "boxed" ? 2 : style === "dock" ? 1 : 1;
	}

	private borderFor(): (line: string) => string {
		return (line: string) => this.borderColorFor()(line);
	}

	/** Session color takes priority; otherwise use the theme's primary accent,
	 * never the thinking-effort-dependent editor border. */
	private borderColorFor(): (line: string) => string {
		const color = this.snapshot.editorBorderColor;
		if (color) {
			return rgbBorder(color, this.fullTheme?.getColorMode() === "256color" ? "256color" : "truecolor");
		}
		const fg = this.fullTheme?.fg?.bind(this.fullTheme);
		if (fg) return (line) => fg("accent", line);
		return this.piTheme.borderColor;
	}

	private frame(
		width: number,
		style: "compact" | "boxed" | "dock" | "native",
		body: string[],
		metadata: string[],
		topBorder: string,
	): string[] {
		const kind = this.frameKind(style);
		const bottomBorder = this.frameBottomBorder(width, kind);
		const inner = Math.max(0, width - 2);
		if (kind === "rounded") {
			// Rounded box with vertical side borders: `╭─╮ / │ text │ / ╰─╯`.
			// Body lines were rendered at width - 2; re-fit defensively, then wrap.
			// Side glyphs use the raw border color (no full-width padding, unlike border()).
			const sideColor = this.borderColorFor();
			const side = (line: string) => `${sideColor("│")}${widthSafe(line, inner)}${sideColor("│")}`;
			return [topBorder, ...body.map(side), bottomBorder, ...metadata];
		}
		return [topBorder, ...body, bottomBorder, ...metadata];
	}

	private metadata(width: number, style: "compact" | "boxed" | "dock" | "native"): string[] {
		if (!this.config.editor.showMetadata || width < 60) return [];
		const percent = contextPercent(this.snapshot.context ?? {});
		if (percent === undefined) return [];
		const label = `ctx ${Math.round(percent)}%`;
		return [this.piTheme.borderColor(` ${style === "boxed" ? "· " : ""}${label}`)];
	}
}

export function installEditor(options: {
	host: EditorHost;
	config: NormalizedPiStyleConfig;
	generation: number;
	initialSnapshot: StatusSnapshot;
	isCurrent?: () => boolean;
	clipboardImagePaste?: EditorOptions["clipboardImagePaste"];
}): EditorInstallation | undefined {
	if (!options.host.setEditorComponent) return undefined;
	const previous = options.host.getEditorComponent?.();
	if (previous && options.config.compatibility.preferExistingEditor) {
		return {
			generation: options.generation,
			installedFactory: previous,
			previousFactory: previous,
			preservedPrevious: true,
			update() {},
			configure() {},
			dispose() {},
		};
	}
	let config = options.config;
	let snapshot = options.initialSnapshot;
	let disposed = false;
	const components = new Set<StyledEditor>();
	const factory = ((tui: Tui, theme: PiEditorTheme, keybindings: Keybindings) => {
		const editor = new StyledEditor(tui, theme, keybindings, {
			config,
			snapshot,
			theme,
			...(options.host.theme ? { fullTheme: options.host.theme } : {}),
			...(options.clipboardImagePaste ? { clipboardImagePaste: options.clipboardImagePaste } : {}),
			onSnapshot: (next) => {
				if (!disposed && options.isCurrent?.() !== false) snapshot = next;
			},
		});
		components.add(editor);
		return editor;
	}) as EditorFactory;
	try {
		options.host.setEditorComponent(factory);
	} catch {
		options.host.notify?.("pi-style editor unavailable; keeping the native editor", "warning");
		return undefined;
	}
	return {
		generation: options.generation,
		installedFactory: factory,
		previousFactory: previous,
		preservedPrevious: false,
		update(next) {
			if (disposed || options.isCurrent?.() === false) return;
			snapshot = next;
			for (const component of components) component.update(next);
		},
		configure(next) {
			if (disposed || options.isCurrent?.() === false) return;
			config = next;
			for (const component of components) component.configure(next);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const component of components) component.dispose();
			components.clear();
			if (options.host.getEditorComponent?.() === factory) {
				options.host.setEditorComponent(previous);
			}
		},
	};
}
