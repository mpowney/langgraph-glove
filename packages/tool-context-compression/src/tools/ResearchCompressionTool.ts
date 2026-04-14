import type { ToolHandler, ToolMetadata } from "@langgraph-glove/tool-server";

const DEFAULT_MAX_DIGEST_CHARS = 4000;
const DEFAULT_MODE = "research-digest";

const RESEARCH_SIGNAL_PATTERNS = [
  /https?:\/\//i,
  /\b(source|sources|official|report|reported|reports|according to|update|updated)\b/i,
  /\b(confirm|confirmed|confirms|final|team|injury|odds|margin|lineup|selection)\b/i,
  /\b(question|unknown|unclear|pending|awaiting|monitor|follow up|next|check)\b/i,
  /\b(contra(?:dict|diction)|conflict|however|but|different)\b/i,
];

export const researchCompressionToolMetadata: ToolMetadata = {
  name: "research_context_compress",
  description:
    "Use {name} to compress long-running research transcripts into a bounded digest that preserves findings, URLs, contradictions, and next leads.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: [DEFAULT_MODE],
        description: "Compression mode. The initial implementation supports research-digest only.",
      },
      currentDigest: {
        type: "string",
        description: "Existing running digest produced by earlier compression passes.",
      },
      transcript: {
        type: "string",
        description: "Transcript chunk to compress into the running research digest.",
      },
      maxDigestChars: {
        type: "number",
        description: "Maximum number of characters for the returned digest.",
      }
    },
    required: ["transcript"]
  }
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\t/g, " ").replace(/[ ]{2,}/g, " ").trim();
}

function stripMessageRoleMarkers(value: string): string {
  return value
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitIntoCandidateLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => stripMessageRoleMarkers(normalizeWhitespace(line)))
    .filter(Boolean);
}

function splitIntoSentences(text: string): string[] {
  return stripMessageRoleMarkers(normalizeWhitespace(text))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
  return dedupePreserveOrder(matches.map((url) => url.replace(/[.,;:!?]+$/, "")));
}

function scoreResearchSentence(sentence: string): number {
  let score = 0;
  for (const pattern of RESEARCH_SIGNAL_PATTERNS) {
    if (pattern.test(sentence)) score += 2;
  }
  if (/\b(confirmed|official|final|source|reported)\b/i.test(sentence)) score += 2;
  if (/https?:\/\//i.test(sentence)) score += 3;
  if (sentence.length > 280) score -= 1;
  return score;
}

function selectResearchHighlights(text: string, limit: number): string[] {
  const lines = splitIntoCandidateLines(text);
  const sentences = splitIntoSentences(text);
  const ranked = [...lines, ...sentences]
    .map((entry) => ({ entry, score: scoreResearchSentence(entry) }))
    .filter(({ score, entry }) => score > 0 && entry.length <= 420)
    .sort((left, right) => right.score - left.score || left.entry.length - right.entry.length)
    .map(({ entry }) => entry);

  return dedupePreserveOrder(ranked).slice(0, limit);
}

function selectUnresolvedItems(text: string, limit: number): string[] {
  const patterns = /\b(unclear|unknown|unconfirmed|pending|awaiting|question|follow up|check|monitor|conflict|contradict)\b/i;
  const candidates = [...splitIntoCandidateLines(text), ...splitIntoSentences(text)]
    .filter((entry) => patterns.test(entry) && entry.length <= 320);
  return dedupePreserveOrder(candidates).slice(0, limit);
}

function extractPriorDigestHighlights(currentDigest: string | undefined, limit: number): string[] {
  if (!currentDigest) return [];
  const bullets = currentDigest
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line.replace(/^[-*]\s*/, "")))
    .filter((line) => line.length >= 20 && !line.endsWith(":"));
  return dedupePreserveOrder(bullets).slice(0, limit);
}

function buildSection(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [title, ...items.map((item) => `- ${item}`), ""];
}

function trimDigest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim();
  const truncated = text.slice(0, Math.max(0, maxChars - 32)).trimEnd();
  return `${truncated}\n\n[truncated to fit digest budget]`;
}

function buildResearchDigest(params: {
  currentDigest?: string;
  transcript: string;
  maxDigestChars: number;
}): string {
  const priorHighlights = extractPriorDigestHighlights(params.currentDigest, 4);
  const findings = selectResearchHighlights(params.transcript, 8);
  const unresolved = selectUnresolvedItems(params.transcript, 4);
  const urls = extractUrls(`${params.currentDigest ?? ""}\n${params.transcript}`).slice(0, 10);

  const sections = [
    ...buildSection("Research Digest", findings),
    ...buildSection("Carry Forward", priorHighlights),
    ...buildSection("Open Questions", unresolved),
    ...buildSection("Sources", urls),
  ];

  const digest = sections.join("\n").trim();
  if (digest.length > 0) {
    return trimDigest(digest, params.maxDigestChars);
  }

  const fallback = trimDigest(normalizeWhitespace(params.transcript), params.maxDigestChars);
  return [
    "Research Digest",
    `- ${fallback || "No compressible research content found."}`,
  ].join("\n");
}

export function createResearchCompressionHandler(): ToolHandler {
  return async (params: Record<string, unknown>) => {
    const transcript = typeof params.transcript === "string"
      ? params.transcript
      : "";
    if (!transcript.trim()) {
      throw new Error("transcript is required");
    }

    const mode = typeof params.mode === "string" ? params.mode : DEFAULT_MODE;
    if (mode !== DEFAULT_MODE) {
      throw new Error(`Unsupported compression mode: ${mode}`);
    }

    const maxDigestChars =
      typeof params.maxDigestChars === "number" && Number.isFinite(params.maxDigestChars) && params.maxDigestChars > 0
        ? Math.floor(params.maxDigestChars)
        : DEFAULT_MAX_DIGEST_CHARS;
    const currentDigest = typeof params.currentDigest === "string" ? params.currentDigest : undefined;

    const digest = buildResearchDigest({
      currentDigest,
      transcript,
      maxDigestChars,
    });

    return {
      digest,
      stats: {
        inputChars: transcript.length,
        outputChars: digest.length,
        sourceCount: extractUrls(transcript).length,
      },
    };
  };
}