/** Pi boolean flags use presence, including `=false`; `--` ends option parsing. */
export function isPiStyleDisabled(argv: readonly string[]): boolean {
	for (const arg of argv) {
		if (arg === "--") break;
		if (arg === "--disable-pi-style" || arg.startsWith("--disable-pi-style=")) return true;
	}
	return false;
}
