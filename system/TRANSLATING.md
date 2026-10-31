# Translating mariowOS

mariowOS can be shown in other languages (Settings › General › Language).
English is written directly in the pages; every other language is one JSON file.
Anything not translated yet simply stays in English, so a partial translation is fine.

## Add a new language

1. Fork this repository and create a branch.
2. Pick the language code: lowercase, e.g. `fr`, `de`, `es`, or `pt-br` for a regional
   variant.
3. Create the file to translate (needs only [Node.js](https://nodejs.org)):

   ```sh
   node tools/check-locales.js --new fr
   ```

   This creates `desktop/assets/locales/fr.json` with every text of the system, in English.
   Translate the **values**, never the keys:

   ```json
   "general.language": "Langue",
   ```

   Keep words in braces exactly as they are: in `"Deleted {count} files"` the `{count}` is
   replaced by a number, so the translation must contain `{count}` too.
4. Add your language to `desktop/assets/locales/languages.json`, with its name written in
   that language:

   ```json
   {
     "en": "English",
     "it": "Italiano",
     "fr": "Français"
   }
   ```
5. Check your work:

   ```sh
   node tools/check-locales.js
   ```

   It shows how many texts are translated and points out mistakes: invalid JSON, a key
   with a typo, an empty translation, a missing `{placeholder}`, a language missing from
   `languages.json`. Texts still in English are fine, but count as not translated: remove
   them from the file if you don't translate them.
6. Open a pull request. The same check runs automatically on it.

That's all: no code changes are needed. After the next update the language appears in
Settings › General › Language.

## Improve an existing language

When the system gets new texts, they show in English until someone translates them. To see
what a language is missing, with the English text of each:

```sh
node tools/check-locales.js --missing fr
```

Add those lines to `fr.json`, translate them, run `node tools/check-locales.js` and open a
pull request.

## Rules for translations

- Keep the file valid JSON: double quotes, a comma after every line except the last.
- Keep translations short: they are buttons, menu items and titles.
- Don't translate brand and feature names such as mariowOS, Wi-Fi, Bluetooth.
- Use the forms the language's own operating systems use (e.g. formal vs. informal).
- To see a text in context, search the repository for its key.

## For developers: making text translatable

Every page loads, first thing in `<head>`:

```html
<script src="/desktop/assets/i18n-data.js"></script>
<script src="/desktop/assets/i18n.js"></script>
```

- In HTML, mark text with `data-i18n="area.key"` (or `data-i18n-placeholder`,
  `data-i18n-title`, `data-i18n-aria-label` for those attributes), keeping the English text in
  the page. Elements added later by scripts are translated too.
- In scripts, write `mariowOSI18n.t("area.key", "English text")`, with values
  `mariowOSI18n.t("area.key", "Deleted {count} files", { count })`. Always write the key and the
  English as plain strings: `tools/check-locales.js` reads them from the code.
- For dates and numbers, pass `mariowOSI18n.locale` to `toLocaleString` / `Intl`.

Then add the key's Italian to `it.json`; `node tools/check-locales.js --missing it` lists any
you forgot. The recovery screen shown when the system cannot start (`kernel-recovery.html`)
runs without the system and keeps its own strings, in English and Italian only.
