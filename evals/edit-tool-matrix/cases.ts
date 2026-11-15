import type { MatrixCase } from "./fixtures.ts";

export const EDIT_MATRIX_CASES: MatrixCase[] = [
	{
		id: "bare-plus-blank-line",
		title: "Bare `+` blank-line insertion + blank line inside SWAP body",
		instruction:
			"In `src/math.ts`, insert a blank line before `export function mul` and update `add` to have a blank line between its guard and return statement. Use a single `edit` call.",
		files: {
			"src/math.ts": [
				"export function add(a: number, b: number): number {",
				"\tif (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(\"nan\");",
				"\treturn a + b;",
				"}",
				"export function mul(a: number, b: number): number {",
				"\treturn a * b;",
				"}",
			].join("\n"),
		},
		goldenPatchTemplate: [
			"[src/math.ts#{{TAG:src/math.ts}}]",
			"INS.POST 2:",
			"+",
			"INS.PRE 5:",
			"+",
		].join("\n"),
		expectedFiles: {
			"src/math.ts": [
				"export function add(a: number, b: number): number {",
				"\tif (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(\"nan\");",
				"",
				"\treturn a + b;",
				"}",
				"",
				"export function mul(a: number, b: number): number {",
				"\treturn a * b;",
				"}",
			].join("\n"),
		},
	},
	{
		id: "literal-plus-minus-prefix",
		title: "Literal leading `+` and `-` body rows (`++x` / `+-x`)",
		instruction:
			"In `notes.txt`, replace `# old` and `# keep` with literal lines `+added` and `-removed` using a single `edit` call.",
		files: {
			"notes.txt": [
				"# header",
				"# old",
				"# keep",
				"# footer",
			].join("\n"),
		},
		goldenPatchTemplate: [
			"[notes.txt#{{TAG:notes.txt}}]",
			"SWAP 2.=3:",
			"++added",
			"+-removed",
		].join("\n"),
		expectedFiles: {
			"notes.txt": [
				"# header",
				"+added",
				"-removed",
				"# footer",
			].join("\n"),
		},
	},
	{
		id: "multi-hunk-single-file",
		title: "Non-adjacent SWAP + INS.POST + DEL in one file",
		instruction:
			"In `src/config.ts`: (1) change `retries = 1` to `retries = 3`, (2) delete the `debug = true;` line, and (3) add `export const strict = true;` after `export const timeoutMs = 5000;`. Keep all other lines untouched in one `edit` call.",
		files: {
			"src/config.ts": [
				"export const retries = 1;",
				"export const region = \"us-east\";",
				"export const debug = true;",
				"export const timeoutMs = 5000;",
			].join("\n"),
		},
		goldenPatchTemplate: [
			"[src/config.ts#{{TAG:src/config.ts}}]",
			"SWAP 1.=1:",
			"+export const retries = 3;",
			"DEL 3",
			"INS.POST 4:",
			"+export const strict = true;",
		].join("\n"),
		expectedFiles: {
			"src/config.ts": [
				"export const retries = 3;",
				"export const region = \"us-east\";",
				"export const timeoutMs = 5000;",
				"export const strict = true;",
			].join("\n"),
		},
	},
	{
		id: "multi-file-single-call",
		title: "Two files updated in a single `edit` call",
		instruction:
			"In one `edit` call: rename `getUser` to `fetchUser` in `src/api.ts` and update its call site in `src/main.ts`.",
		files: {
			"src/api.ts": [
				"export function getUser(id: string): string {",
				"\treturn `user:${id}`;",
				"}",
			].join("\n"),
			"src/main.ts": [
				"import { getUser } from \"./api\";",
				"console.log(getUser(\"42\"));",
			].join("\n"),
		},
		goldenPatchTemplate: [
			"[src/api.ts#{{TAG:src/api.ts}}]",
			"SWAP 1.=1:",
			"+export function fetchUser(id: string): string {",
			"[src/main.ts#{{TAG:src/main.ts}}]",
			"SWAP 1.=2:",
			"+import { fetchUser } from \"./api\";",
			"+console.log(fetchUser(\"42\"));",
		].join("\n"),
		expectedFiles: {
			"src/api.ts": [
				"export function fetchUser(id: string): string {",
				"\treturn `user:${id}`;",
				"}",
			].join("\n"),
			"src/main.ts": [
				"import { fetchUser } from \"./api\";",
				"console.log(fetchUser(\"42\"));",
			].join("\n"),
		},
	},
	{
		id: "indented-escapes",
		title: "Tab-indented template interpolations, regex backslashes, and quotes",
		instruction:
			"In `src/format.ts`, replace `return raw.trim();` with `return `${prefix}:\\n\\t${raw.replace(/\\s+/g, \" \")}`;` preserving the tab indentation.",
		files: {
			"src/format.ts": [
				"export function formatLine(prefix: string, raw: string): string {",
				"\treturn raw.trim();",
				"}",
			].join("\n"),
		},
		goldenPatchTemplate: [
			"[src/format.ts#{{TAG:src/format.ts}}]",
			"SWAP 2.=2:",
			"+\treturn `${prefix}:\\n\\t${raw.replace(/\\s+/g, \" \")}`;",
		].join("\n"),
		expectedFiles: {
			"src/format.ts": [
				"export function formatLine(prefix: string, raw: string): string {",
				"\treturn `${prefix}:\\n\\t${raw.replace(/\\s+/g, \" \")}`;",
				"}",
			].join("\n"),
		},
	},
	{
		id: "block-anchor-decorator",
		title: "SWAP.BLK on function opener + INS.BLK.POST outside block",
		instruction:
			"In `src/greet.ts`, replace the `greet` function body so it returns `Hi, ${name}` instead of logging, and add `export const ready = true;` immediately after the `greet` function block.",
		files: {
			"src/greet.ts": [
				"export function greet(name: string): string {",
				"\tconst msg = `Hello, ${name}`;",
				"\treturn msg;",
				"}",
			].join("\n"),
		},
		goldenPatchTemplate: [
			"[src/greet.ts#{{TAG:src/greet.ts}}]",
			"SWAP.BLK 1:",
			"+export function greet(name: string): string {",
			"+\treturn `Hi, ${name}`;",
			"+}",
			"INS.BLK.POST 1:",
			"+export const ready = true;",
		].join("\n"),
		expectedFiles: {
			"src/greet.ts": [
				"export function greet(name: string): string {",
				"\treturn `Hi, ${name}`;",
				"}",
				"export const ready = true;",
			].join("\n"),
		},
	},
	{
		id: "tight-single-line-swap-and-mv",
		title: "Tight `SWAP N.=N:` expanding 1 line to 3 lines + `MV`",
		instruction:
			"In `src/old.ts`, replace line 1 (`export const v = 1;`) with a 3-line version (`export const major = 1;`, `export const minor = 0;`, `export const patch = 0;`) and move the file to `src/version.ts` in one `edit` call.",
		files: {
			"src/old.ts": "export const v = 1;",
		},
		goldenPatchTemplate: [
			"[src/old.ts#{{TAG:src/old.ts}}]",
			"SWAP 1.=1:",
			"+export const major = 1;",
			"+export const minor = 0;",
			"+export const patch = 0;",
			"MV src/version.ts",
		].join("\n"),
		expectedFiles: {
			"src/version.ts": [
				"export const major = 1;",
				"export const minor = 0;",
				"export const patch = 0;",
			].join("\n"),
		},
	},
];

export function getCaseById(id: string): MatrixCase {
	const found = EDIT_MATRIX_CASES.find(c => c.id === id);
	if (!found) {
		throw new Error(`Unknown edit matrix case: ${id}`);
	}
	return found;
}
