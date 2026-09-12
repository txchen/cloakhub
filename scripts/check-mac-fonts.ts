// Checks discoverability, not font provenance or glyph coverage.
const required = [
  "Apple Color Emoji", "Arial", "Arial Narrow", "Arial Unicode MS", "Comic Sans MS",
  "Courier", "Courier New", "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue",
  "Impact", "Menlo", "Microsoft Sans Serif", "Monaco", "Tahoma", "Times New Roman",
  "Trebuchet MS", "Webdings", "Wingdings"
];
const result = Bun.spawnSync(["fc-list", "--format", "%{family}\n"]);
if (result.exitCode !== 0) throw new Error("fontconfig could not list installed fonts");
const families = new Set(result.stdout.toString().split(/[\n,]/).map((name) => name.trim()));
const missing = required.filter((name) => !families.has(name));
if (missing.length) throw new Error(`Mac font directory is incomplete. Missing: ${missing.join(", ")}`);
console.log(`Mac font check: ${required.length}/${required.length} required families found`);
