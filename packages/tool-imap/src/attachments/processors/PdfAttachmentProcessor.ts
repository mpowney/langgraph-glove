import type {
  AttachmentExtractionInput,
  AttachmentExtractionOutput,
  AttachmentExtractionRuntime,
  AttachmentProcessor,
} from "../AttachmentProcessors";

export class PdfAttachmentProcessor implements AttachmentProcessor {
  readonly id = "pdf-hybrid";

  readonly mimeTypes = ["application/pdf"];

  async extract(input: AttachmentExtractionInput, runtime: AttachmentExtractionRuntime): Promise<AttachmentExtractionOutput> {
    const layoutText = (await runtime.extractPdfLayoutText({
      content: input.content,
      filename: input.filename,
    }))?.trim() ?? "";

    if (looksConfidentPdfText(layoutText)) {
      return { text: layoutText };
    }

    const ocrText = (await runtime.ocrPdfPages({
      content: input.content,
      filename: input.filename,
    })).trim();

    if (!layoutText) {
      return {
        text: ocrText,
        markdownText: buildMarkdown([
          { title: "OCR text", content: ocrText },
        ]),
      };
    }

    if (!ocrText) {
      return { text: layoutText };
    }

    return {
      text: `${layoutText}\n\n[OCR fallback]\n${ocrText}`,
      markdownText: buildMarkdown([
        { title: "Layout text", content: layoutText },
        { title: "OCR fallback", content: ocrText },
      ]),
    };
  }
}

function buildMarkdown(sections: Array<{ title: string; content: string }>): string | undefined {
  const normalizedSections = sections
    .map((section) => ({
      title: section.title.trim(),
      content: section.content.trim(),
    }))
    .filter((section) => section.title.length > 0 && section.content.length > 0);

  if (normalizedSections.length === 0) return undefined;

  return normalizedSections
    .map((section) => `## ${section.title}\n\n\`\`\`text\n${section.content}\n\`\`\``)
    .join("\n\n");
}

function looksConfidentPdfText(text: string): boolean {
  if (!text) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 60) return false;

  const printableChars = text.replace(/\s+/g, "");
  if (!printableChars) return false;
  const weirdRatio = (printableChars.match(/[^\x20-\x7E]/g)?.length ?? 0) / printableChars.length;
  return weirdRatio < 0.35;
}
