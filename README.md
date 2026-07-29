# Mastra Translation Framework

Mastra Translation Framework is an agent that translates documents with consistent terminology. You provide a document, the target language, and optionally a glossary and a style guide. It splits the document into parts, translates them one after another while keeping terminology consistent, reviews the finished translation, and writes the result to a file for you.

It is meant for documents where consistency matters: documentation, subtitles, rulebooks, game localizations, website and app translation files.

## Supported Documents

| Input      | Output     |
| ---------- | ---------- |
| PDF        | Markdown   |
| Markdown   | Markdown   |
| Plain text | Plain text |
| JSON       | JSON       |
| SRT        | SRT        |
| ASS/SSA    | ASS        |

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
- `DATALAB_API_KEY` - only needed if you want to translate PDFs. Get one at
  [datalab.to](https://www.datalab.to). Everything else works without it.

3. Start the app:

```bash
npm/bun run dev
```

Open the address it prints (usually <http://localhost:4111>) in your browser.

> [!NOTE]
> For advanced setup (server deployment, API, framework integration) see [Mastra docs](https://mastra.ai/docs).

## Your Documents

Place your document files/directories in the workspace:

```
src/mastra/public/workspace/
```

Put your documents, glossaries, and style guides in there before starting a translation. You
can use subfolders to keep projects apart, for example
`workspace/game/rulebook.pdf`. When you tell the app which file to use, give the path
without the workspace part, so `game/rulebook.pdf`.

> [!WARNING]
> The app can only see files inside this folder, and it will never touch anything outside it.

## Translating a Document

Open the app in your browser and pick the **Localization Agent**, then just say what you
want, for example:

> Translate game/rulebook.pdf into Russian. Use game/glossary.csv and the style guide in game/style.md

The agent will ask for anything it still needs. It then starts the run and reports progress as it converts, translates, and reviews each part.

### Direct Workflow

If you prefer filling in a form over chat agent, open Workflows -> **localizeDocumentWorkflow** and enter the same information in the fields:

**Required**

- `sourcePath` - your document, for example `game/rulebook.pdf` or `anime/episode-01.srt`
- `targetLanguage` - the language to translate into, for example `Russian` or `pt-BR`
- `glossaryPath` - your glossary file

**Optional**

- `styleGuidePath` - your style guide file, if you have one
- `styleGuide` - short instructions typed directly, instead of or in addition to a file
- `sourceLanguage` - only if you want to override automatic detection
- `outputPath` - only if you want the result somewhere specific

## Subtitles

SubRip (`.srt`) and Advanced SubStation Alpha (`.ass`, `.ssa`) files work like any other
document. Point the agent or the workflow at them the same way:

> Translate anime/episode-01.ass into English. Use anime/glossary.csv

Only the spoken text is ever sent to the translator. Timings, cue numbering, style
definitions, script headers, and positioning are preserved as-is.

The editor pass adds two checks on top of the usual ones: reading speed, flagging cues that
grew too long for their slot, and continuity between consecutive cues.

## The Glossary

The glossary is how you keep names and key terms translated the same way everywhere. It is
optional, but it makes a big difference on long documents.

You can write it as CSV, JSON, Markdown, or a plain text. All of these are understood:

**CSV**

**Recommended**. You can export Google Sheets or Excel spreadsheet into CSV directly.

```csv
source,target,notes
Code Geass,Код Гиасс,
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

## Your Results

Each translation run gets its own folder inside the workspace:

```
localization/<run-id>/
  rulebook.target.md      the finished translation
  glossary.json           every term used, including the ones proposed during the run
  report.json             a summary of the run and anything the reviewer flagged
  parts/                  the original document split into pieces
  translated/             the first-pass translation of each piece
  reviewed/               each piece after review
```

The finished translation is the file named after your document and the target language.
`report.json` is worth a look: it lists how the document was split and every problem the
reviewer noticed, with a severity, so you know which spots deserve a human read.

JSON and subtitle runs skip the `parts/`, `translated/`, and `reviewed/` folders, because
their parts are batches of strings or cues rather than pieces of prose. `report.json` still
records how many went into each batch.

The intermediate folders are kept on purpose. If a run fails halfway through, for example
because the network dropped, starting it again reuses the work that already succeeded instead of paying for it twice.

## Other Agents

Not everything needs a full localization run. Two more Agents are available:

- **Translator Agent** - translate a phrase or check how a term should read.
- **Editor Agent** - review a translation you already have.

Use these for quick questions. For anything document-sized, use the **Localization Agent** or the workflow so you get the glossary and the review pass.

## Costs

A full translation of 250-page PDF using `gemini-3.6-flash` costs about $5 with $1.5 for OCR and $3.5 for AI translation.

> [!NOTE]
> Datalab OCR provides $10-20 free credits a month, so you really only have to pay for your AI provider.

A subtitle file for a single anime episode is < $0.3
