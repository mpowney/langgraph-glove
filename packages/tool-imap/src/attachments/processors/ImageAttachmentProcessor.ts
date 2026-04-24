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
      return { text: ocrText };
    }

    const caption = (await runtime.describePhoto({
      content: input.content,
      contentType: input.contentType,
      filename: input.filename,
    })).trim();

    if (!ocrText) {
      return { text: caption };
    }
    if (!caption) {
      return { text: ocrText };
    }

    return {
      text: `${ocrText}\n\n[Photo description]\n${caption}`,
    };
  }
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
