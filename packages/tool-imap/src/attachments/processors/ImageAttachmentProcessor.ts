import type {
  AttachmentExtractionInput,
  AttachmentExtractionOutput,
  AttachmentExtractionRuntime,
  AttachmentProcessor,
} from "../AttachmentProcessors";

export class ImageAttachmentProcessor implements AttachmentProcessor {
  readonly id = "image-ocr-caption";

  readonly mimeTypes = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/tiff",
  ];

  async extract(input: AttachmentExtractionInput, runtime: AttachmentExtractionRuntime): Promise<AttachmentExtractionOutput> {
    const ocrText = (await runtime.ocrImage({
      content: input.content,
      contentType: input.contentType,
      filename: input.filename,
    })).trim();

    if (!shouldAddPhotoCaption(input.contentType, ocrText)) {
      return {
        text: ocrText,
        markdownText: buildMarkdown([
          { title: "OCR text", content: ocrText },
        ]),
      };
    }

    const caption = (await runtime.describePhoto({
      content: input.content,
      contentType: input.contentType,
      filename: input.filename,
    })).trim();

    if (!ocrText) {
      return {
        text: caption,
        markdownText: buildMarkdown([
          { title: "Photo description", content: caption },
        ]),
      };
    }
    if (!caption) {
      return {
        text: ocrText,
        markdownText: buildMarkdown([
          { title: "OCR text", content: ocrText },
        ]),
      };
    }

    return {
      text: `${ocrText}\n\n[Photo description]\n${caption}`,
      markdownText: buildMarkdown([
        { title: "OCR text", content: ocrText },
        { title: "Photo description", content: caption },
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

function shouldAddPhotoCaption(contentType: string, ocrText: string): boolean {
  const normalized = normalizeMime(contentType);
  const likelyPhotoType = normalized === "image/jpeg" || normalized === "image/jpg" || normalized === "image/heic";
  const lowTextDensity = ocrText.split(/\s+/).filter(Boolean).length < 12;
  return likelyPhotoType || lowTextDensity;
}

function normalizeMime(value: string): string {
  return value.toLowerCase().split(";")[0]?.trim() ?? "application/octet-stream";
}
