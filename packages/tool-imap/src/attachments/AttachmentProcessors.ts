import {
  ImageAttachmentProcessor,
  PdfAttachmentProcessor,
  Utf8TextAttachmentProcessor,
} from "./processors/index";

export interface AttachmentExtractionInput {
  content: Buffer;
  contentType: string;
  filename: string;
}

export interface AttachmentExtractionRuntime {
  extractPdfLayoutText(input: { content: Buffer; filename: string }): Promise<string | null>;
  ocrPdfPages(input: { content: Buffer; filename: string }): Promise<string>;
  ocrImage(input: { content: Buffer; contentType: string; filename: string }): Promise<string>;
  describePhoto(input: { content: Buffer; contentType: string; filename: string }): Promise<string>;
}

export interface AttachmentExtractionOutput {
  text: string;
}

export interface AttachmentProcessor {
  readonly id: string;
  readonly mimeTypes: string[];
  extract(input: AttachmentExtractionInput, runtime: AttachmentExtractionRuntime): Promise<AttachmentExtractionOutput>;
}

export class AttachmentProcessorRegistry {
  private readonly byMime = new Map<string, AttachmentProcessor>();

  constructor(processors: AttachmentProcessor[]) {
    for (const processor of processors) {
      for (const mimeType of processor.mimeTypes) {
        const key = normalizeMime(mimeType);
        if (!this.byMime.has(key)) {
          this.byMime.set(key, processor);
        }
      }
    }
  }

  resolve(contentType: string): AttachmentProcessor | null {
    const normalized = normalizeMime(contentType);
    return this.byMime.get(normalized) ?? null;
  }

  supportedMimeTypes(): string[] {
    return [...this.byMime.keys()].sort((left, right) => left.localeCompare(right));
  }
}

export function createDefaultAttachmentProcessors(): AttachmentProcessor[] {
  return [
    new Utf8TextAttachmentProcessor(),
    new PdfAttachmentProcessor(),
    new ImageAttachmentProcessor(),
  ];
}

function normalizeMime(value: string): string {
  return value.toLowerCase().split(";")[0]?.trim() ?? "application/octet-stream";
}
