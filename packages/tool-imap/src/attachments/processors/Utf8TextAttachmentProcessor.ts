import type {
  AttachmentExtractionInput,
  AttachmentExtractionOutput,
  AttachmentExtractionRuntime,
  AttachmentProcessor,
} from "../AttachmentProcessors";

export class Utf8TextAttachmentProcessor implements AttachmentProcessor {
  readonly id = "utf8-text";

  readonly mimeTypes = [
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "application/json",
    "application/xml",
    "text/xml",
  ];

  async extract(input: AttachmentExtractionInput, _runtime: AttachmentExtractionRuntime): Promise<AttachmentExtractionOutput> {
    if (!input.content.length) {
      return { text: "" };
    }

    if (input.contentType === "text/html") {
      return { text: stripHtml(input.content.toString("utf8")) };
    }

    return { text: input.content.toString("utf8") };
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
