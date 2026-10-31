#!/usr/bin/env node
// Checks the system translations in desktop/assets/locales/ (see TRANSLATING.md).
//   node tools/check-locales.js             check every language
//   node tools/check-locales.js --new fr    create fr.json with the English text to translate
//   node tools/check-locales.js --missing fr  list what fr.json still lacks, with the English
// Errors (exit code 1): invalid JSON, a language listed in languages.json without its
// <code>.json or the other way round, bad language codes, non-text or empty translations,
// keys the system does not use, {placeholders} that differ from the English.
// Warnings: keys not translated yet (they show in English).
//
// The keys and their English text are read from the pages themselves: data-i18n,
// data-i18n-placeholder / -title / -aria-label attributes, and mariowOSI18n.t("key", "English")
// calls.

const fs = require("fs");
const path = require("path");

const systemDir = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["desktop", "loginui", "lockscreen", "recovery"].map(dir => path.join(systemDir, dir));
const localesDir = path.join(systemDir, "desktop", "assets", "locales");
const CODE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;
const SKIP_DIRS = new Set(["vendor", "node_modules", "locales"]);
const SKIP_FILES = new Set(["i18n.js"]); // its comments show example keys

const inActions = !!process.env.GITHUB_ACTIONS;
let errors = 0;
let warnings = 0;
function report(kind, file, message) {
  if (kind === "error") errors++; else warnings++;
  const rel = path.relative(systemDir, file);
  console.log(inActions ? `::${kind} file=${rel}::${message}` : `${kind.toUpperCase()} ${rel}: ${message}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { report("error", file, `not valid JSON (${error.message})`); return null; }
}

const decode = text => text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
const unquote = literal => { try { return JSON.parse(literal); } catch { return literal.slice(1, -1).replace(/\\(['"`])/g, "$1"); } };

// key -> English text (the first one found), read from every page and script.
function findKeys(dir, keys = new Map()) {
  if (!fs.existsSync(dir)) return keys;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) findKeys(full, keys); continue; }
    if (!/\.(html|js)$/.test(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    const add = (key, english) => { if (!keys.has(key) || (!keys.get(key) && english)) keys.set(key, english || ""); };
    for (const [tag] of text.matchAll(/<[a-z][^<>]*\bdata-i18n(?:-[a-z-]+)?="[^"]+"[^<>]*>/gi)) {
      const textKey = tag.match(/\bdata-i18n="([^"]+)"/);
      if (textKey) {
        const after = text.slice(text.indexOf(tag) + tag.length).match(/^([^<]*)</);
        add(textKey[1], after ? decode(after[1]) : "");
      }
      for (const name of ["placeholder", "title", "aria-label"]) {
        const key = tag.match(new RegExp(`\\bdata-i18n-${name}="([^"]+)"`));
        if (!key) continue;
        const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
        add(key[1], value ? decode(value[1]) : "");
      }
    }
    for (const match of text.matchAll(/mariowOSI18n\.t\(\s*["']([^"']+)["']\s*(?:,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`))?/g)) {
      add(match[1], match[2] ? unquote(match[2]) : "");
    }
  }
  return keys;
}

const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(",");

const keys = new Map();
SOURCE_DIRS.forEach(dir => findKeys(dir, keys));
const [mode, target] = process.argv.slice(2);

if (mode === "--new" || mode === "--missing") {
  if (!CODE.test(target || "") || target === "en") {
    console.log('Give a language code, e.g. "fr" or "pt-br".');
    process.exit(1);
  }
  const file = path.join(localesDir, `${target}.json`);
  if (mode === "--new") {
    if (fs.existsSync(file)) { console.log(`${path.relative(systemDir, file)} already exists.`); process.exit(1); }
    const sorted = Object.fromEntries([...keys].sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
    console.log(`Created ${path.relative(systemDir, file)} with ${keys.size} English texts: translate the values,`);
    console.log(`then add "${target}": "<name of the language>" to desktop/assets/locales/languages.json.`);
  } else {
    const dictionary = fs.existsSync(file) ? readJson(file) || {} : {};
    const missing = [...keys].filter(([key]) => !Object.hasOwn(dictionary, key));
    missing.forEach(([key, english]) => console.log(`${JSON.stringify(key)}: ${JSON.stringify(english)},`));
    console.log(`${missing.length} key(s) missing in ${target}.json`);
  }
  process.exit(0);
}

const manifestFile = path.join(localesDir, "languages.json");
const languages = readJson(manifestFile) || {};

for (const [code, name] of Object.entries(languages)) {
  if (!CODE.test(code)) report("error", manifestFile, `"${code}" is not a valid language code (lowercase, e.g. "fr" or "pt-br")`);
  if (typeof name !== "string" || !name.trim()) report("error", manifestFile, `"${code}" needs its name, written in that language`);
  if (code !== "en" && !fs.existsSync(path.join(localesDir, `${code}.json`))) report("error", manifestFile, `"${code}" is listed but ${code}.json is missing`);
}

const files = fs.readdirSync(localesDir).filter(name => name.endsWith(".json") && name !== "languages.json");
for (const name of files) {
  const file = path.join(localesDir, name);
  const code = name.slice(0, -".json".length);
  if (code === "en") { report("error", file, "English lives in the pages themselves; remove en.json"); continue; }
  if (!Object.hasOwn(languages, code)) report("error", file, `add "${code}" to languages.json`);
  const dictionary = readJson(file);
  if (!dictionary) continue;
  if (typeof dictionary !== "object" || Array.isArray(dictionary)) { report("error", file, 'must be an object of "key": "translation"'); continue; }
  for (const [key, value] of Object.entries(dictionary)) {
    if (!keys.has(key)) report("error", file, `"${key}" is not used by the system (typo, or translate the key instead of the value?)`);
    else if (typeof value !== "string" || !value.trim()) report("error", file, `"${key}" must be non-empty text`);
    else if (placeholders(value) !== placeholders(keys.get(key))) report("error", file, `"${key}" must keep the placeholders of the English text: ${JSON.stringify(keys.get(key))}`);
  }
  const missing = [...keys.keys()].filter(key => !Object.hasOwn(dictionary, key));
  missing.forEach(key => report("warning", file, `"${key}" is not translated yet (shown in English)`));
  console.log(`${code}: ${keys.size - missing.length}/${keys.size} keys translated`);
}

console.log(`${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
