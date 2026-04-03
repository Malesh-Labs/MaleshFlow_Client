function formatPromptLines(lines: string[]) {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "(empty)";
}

export const MODEL_REGENERATE_REQUEST =
  "Regenerate the Model section using the current Model lines and the Recent section as context. Refine it into a concise, useful model while preserving important intent and signal.";

export const MODEL_REWRITE_SYSTEM_PROMPT =
  "You rewrite only the Model section of a page. Use Recent Examples only as evidence and inspiration. Never rewrite, summarize, or mention the Recent Examples section in the output. Return concise plain-text model lines only. No bullets, no numbering, no markdown headings, no checkbox syntax.";

export function buildModelRewriteUserPrompt({
  pageTitle,
  request,
  userNote,
  existingModelLines,
  recentExampleLines,
  explicitLinkedContext = "",
  recentConversationLines = [],
}: {
  pageTitle: string;
  request: string;
  userNote?: string;
  existingModelLines: string[];
  recentExampleLines: string[];
  explicitLinkedContext?: string;
  recentConversationLines?: string[];
}) {
  const trimmedUserNote = userNote?.trim() ?? "";

  return [
    `Page title: ${pageTitle}`,
    trimmedUserNote.length > 0 ? `User note to honor first: ${trimmedUserNote}` : "",
    `Request: ${request}`,
    "",
    "Current Model lines:",
    formatPromptLines(existingModelLines),
    "",
    "Recent Examples for context only:",
    formatPromptLines(recentExampleLines),
    explicitLinkedContext.trim().length > 0
      ? ["", "Dereferenced linked context from Current Model and Recent Examples:", explicitLinkedContext].join("\n")
      : "",
    "",
    "Recent conversation:",
    recentConversationLines.length > 0 ? recentConversationLines.join("\n") : "(none)",
  ].join("\n");
}

export const JOURNAL_FEEDBACK_SYSTEM_PROMPT =
  "You generate the Feedback section for a personal journal. Read the Thoughts/Stuff section and return concise plain-text feedback lines that summarize patterns, add perspective, and offer grounded guidance. Be supportive, practical, and non-judgmental. No bullets, no numbering, no markdown headings, no checkbox syntax.";

export function buildJournalFeedbackUserPrompt({
  pageTitle,
  userNote,
  thoughtLines,
  explicitLinkedContext = "",
}: {
  pageTitle: string;
  userNote?: string;
  thoughtLines: string[];
  explicitLinkedContext?: string;
}) {
  const trimmedUserNote = userNote?.trim() ?? "";

  return [
    `Journal date/title: ${pageTitle}`,
    trimmedUserNote.length > 0 ? `User note to honor first: ${trimmedUserNote}` : "",
    "",
    "Thoughts/Stuff:",
    formatPromptLines(thoughtLines),
    explicitLinkedContext.trim().length > 0
      ? [
          "",
          "Dereferenced linked context from Thoughts/Stuff:",
          explicitLinkedContext,
        ].join("\n")
      : "",
  ].join("\n");
}
