# Mastra Translation Framework

Mastra Translation Framework is an agent that translates documents with consistent terminology. You provide one or more documents of the same type, the target language, and optionally a glossary and a style guide. It splits the documents into parts, translates them one after another while keeping terminology consistent, reviews the finished translation, and writes the result to a file for you.

It is meant for documents where consistency matters: documentation, subtitles, books, game localizations, website and app translation files.

## Supported Documents

| Input      | Output     |
| ---------- | ---------- |
| PDF        | Markdown   |
| DOC, DOCX  | Markdown   |
| RTF        | Markdown   |
| ODT        | Markdown   |
| EPUB       | Markdown   |
| Markdown   | Markdown   |
| Plain text | Plain text |
| JSON       | JSON       |
| HTML       | HTML       |
| SRT        | SRT        |
| ASS, SSA   | ASS        |

## Setup

You need [Node.js](https://nodejs.org) 24+ or [Bun](https://bun.com/) 1.3+.

1. Install the dependencies:

```bash
npm/bun install
```

2. Copy `.env.example` to `.env` and fill it in:

- An API key for the AI provider you want to use (for example `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, or `AI_GATEWAY_API_KEY`). Only one is needed.
- `AI_MODEL` - the model that does the translating. The name has to match the
  provider whose key you supplied. Available providers are listed at
  [mastra.ai/models](https://mastra.ai/models/).
- `DATALAB_API_KEY` - optional. Enables remote OCR for PDFs (significantly better accuracy). Without it, PDFs use local text extraction. Get a key at [datalab.to](https://www.datalab.to).

3. Start the app:

```bash
npm/bun run dev
```

Open the address it prints (usually <http://localhost:4111>) in your browser.

> [!NOTE]
> For advanced setup (server deployment, API, framework integration) see [Mastra docs](https://mastra.ai/docs).

## Prepare Your Documents

Place your document files/directories in the workspace:

```
src/mastra/public/workspace/
```

Put your documents, glossaries, and style guides in there before starting a translation. You
can use subfolders to keep projects apart, for example
`workspace/game/rulebook.pdf`.

You can also point the Localization Agent at a whole project folder. Name the files so they
are easy to identify:

| Role        | Example names                                              |
| ----------- | ---------------------------------------------------------- |
| Sources     | `document.pdf`, `page.html`, `episode-01.srt`, `source.md` |
| Glossary    | `glossary.csv`, `glossary.json`, `terms.csv`               |
| Style Guide | `style.md`, `style-guide.txt`, `guide.md`                  |

> [!WARNING]
> The app can only see files inside `workspace` directory, and it will never touch anything outside it.

## Translating a Document

Open the app in your browser and pick the **Localization Agent**, then just say what you
want, for example:

> Translate game/rulebook.pdf into Spanish. Use game/glossary.csv and the style guide in game/style.md

You can also hand it several files of the same type in one go. They share the glossary and
style guide, and terminology decided in an earlier file is reused in the later ones:

> Translate game/ch1.pdf, game/ch2.pdf, and game/ch3.pdf into Spanish. Use game/glossary.csv and game/style.md

Or point it at the project directory and let it find the files automatically:

> Translate documents in "game" directory into Spanish

The agent will ask for anything it still needs. It then starts the run and reports progress as it converts, translates, and reviews each part. Ask it to skip the Editor Agent if you want a faster first-pass translation and save on AI tokens.

### Direct Workflow

If you prefer filling in a form over chat agent, open Workflows -> **localizeDocumentWorkflow** and enter information in the fields. Localization Agent is still a prefered way as it can fix issues and resume workflows in case of errors.

## Subtitles

SubRip (`.srt`) and Advanced SubStation Alpha (`.ass`, `.ssa`) files work like any other
document. Point the agent or the workflow at them the same way:

> Translate anime/episode-01.ass into English. Use anime/glossary.csv

Only the spoken text is ever sent to the translator. Timings, cue numbering, style
definitions, script headers, and positioning are preserved as-is.

## The Glossary

The glossary is how you keep names and key terms translated consistently. It is
optional, but it makes a big difference on long documents or multiple documents.

You can write it as CSV, JSON, Markdown, or a plain text. All of these are understood:

**CSV**

**Recommended**. You can export Google Sheets or Excel spreadsheet into CSV directly.

```csv
source,target,notes
Code Geass,Code Geass,
Lelouch vi Britannia,Лелуш Ви Британия,male
Kallen Kōzuki,Каллен Кодзуки,female
```

**MD / TXT**

Any reasonable separator (`: = ->`) and format should be fine. Just keep it consistent.

```
Code Geass: Код Гиасс
Lelouch vi Britannia = Лелуш Ви Британия (male)
Kallen Kōzuki -> Каллен Кодзуки | female
```

**JSON**

```json
{
  "Lelouch vi Britannia": "Лелуш Ви Британия",
  "Kallen Kōzuki": "Каллен Кодзуки"
}
```

`notes` or `context` column is a good place to tell the translator things like "leave untranslated" or specify character gender. Though, it's completely optional.

While translating, the app also proposes terms of its own for anything important it had to
decide, and reuses them for the rest of the document. Your own terms always have priority over the proposed ones, so nothing you set gets overridden.

## The Style Guide

A style guide is free-form text describing how the translation should read: formal or
informal address, how to handle measurements, whether to keep English product names, house
spelling preferences, and so on. Put it in a `.md` or `.txt` file in the workspace, or type it directly into the chat or the `styleGuide` field.

## Results

Each translation run gets its own folder inside the workspace:

```
localization/<run-id>/
  book.target.md      the finished translation (one file per source document)
  glossary.json           every term used, including the ones proposed during the run
  report.json             a summary of the run and anything the reviewer flagged
  parts/                  the original document(s) split into pieces
  translated/             the first-pass translation of each piece
  reviewed/               each piece after review
```

When you translate several documents in one run, each gets its own output file in that
folder (or in the directory you passed as `outputPath`), and they all share the same
`glossary.json` and `report.json`.

The intermediate folders are kept on purpose. If a run fails halfway through, for example
because the network dropped, starting it again reuses the work that already succeeded instead of paying for it twice.

## Other Agents

Not everything needs a full localization run. Two more Agents are available:

- **Translator Agent** - translate a phrase or check how a term should read.
- **Editor Agent** - review a translation you already have.

Use these for quick questions. For anything document-sized, use the **Localization Agent** or the workflow so you get the glossary and the review pass.

## Costs

A full translation of 250-page PDF using `deepseek/deepseek-v4-flash` costs about $4. `google/gemini-3.6-flash` outputs a better quality translation but is more expensive at about $10 for 250-page document. A subtitle file for a single anime episode is < $0.3.

> [!NOTE]
> You can save AI tokens if you ask the Localization Agent to skip the Editor Agent. While the quality may drop slightly but it will also decrease the costs.

> [!NOTE]
> Datalab OCR provides $10-20 free credits a month, so you really only have to pay for your AI provider. If you need extra OCR volume, you can buy credits there.
