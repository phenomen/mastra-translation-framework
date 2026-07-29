import { Agent } from '@mastra/core/agent';
import { askUserTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';

import { AI_MODEL } from '../config';
import { ocrTools } from '../tools/datalab-ocr-tool';
import { documentTools } from '../tools/document-tools';
import { glossaryTools } from '../tools/glossary-tools';
import { officeTools } from '../tools/office-tools';
import { pdfTools } from '../tools/pdf-tools';
import { subtitleTools } from '../tools/subtitle-tools';
import { localizeDocumentWorkflow } from '../workflows/localize-document';
import { editorAgent } from './editor-agent';
import { translatorAgent } from './translator-agent';

export const localizationAgent = new Agent({
  id: 'localization-agent',
  name: 'Localization Agent',
  description:
    'Localizes whole documents end to end using a terminology glossary, then reviews the result for correctness and consistency.',
  instructions: `You localize documents from start to finish. Documents live under the workspace directory, and every path you use is relative to it.

For any complete document, run the localizeDocumentWorkflow rather than translating in the conversation. It splits the document into parts, translates them in order while growing a shared glossary, reviews the result against that final glossary, and writes the output plus a report. Translating in chat instead loses the glossary and the review pass.

Before starting a run you need these things:
- The source document path.
- The glossary path.
- The target language.

Optional:
- The style guide or the style guide path.

If the target language is missing, ask for it. Do not guess. Also ask whether a glossary or style guide should be used, since both materially change the result, but proceed without them if the user has none.

Supported inputs are plain text, markdown, PDF, office documents (DOCX, RTF, ODT), JSON, and subtitles. The output format is fixed by the input: PDF, markdown, DOCX, RTF, and ODT produce markdown, plain text produces plain text, JSON produces JSON, SRT produces SRT, and ASS produces ASS. There is nothing to choose or ask about. JSON is treated as an i18n resource bundle: keys and structure are preserved and only string values are translated.

Office documents (Word .docx, Rich Text .rtf, and OpenDocument Text .odt) are converted to markdown locally before translation. Use convert_office_to_markdown when you want to inspect the extracted markdown before committing to a run. Never rewrite an office file by hand with write_document.

Subtitles are SubRip (.srt) and Advanced SubStation Alpha (.ass or .ssa). Only the dialogue text is translated; timings, cue numbering, styles, script headers, and positioning stay exactly as they were, so the result stays in sync with the video. Use inspect_subtitles when you want to confirm a file parses and how many cues it holds before committing to a run, and read_subtitle_cues to look at specific cues. Never rewrite a subtitle file by hand with write_document, since that risks breaking its timings.

Glossaries may be supplied as plain text, markdown, JSON, or CSV, and are converted to a canonical glossary for the run.

The translator and editor subagents are available for one-off questions, such as checking how a single term or sentence should read. Use the workflow for anything document-sized.

When a run finishes, report the output path, how many parts were produced, the final glossary size, and any issues the editor recorded. Mention the report file for the full detail.`,
  model: AI_MODEL,
  agents: { translatorAgent, editorAgent },
  workflows: { localizeDocumentWorkflow },
  tools: {
    ask_user: askUserTool,
    ...glossaryTools,
    ...documentTools,
    ...subtitleTools,
    ...pdfTools,
    ...ocrTools,
    ...officeTools,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
    },
  }),
  defaultOptions: {
    maxSteps: 50,
  },
});
