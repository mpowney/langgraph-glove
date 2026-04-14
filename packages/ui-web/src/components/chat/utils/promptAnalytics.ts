const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export function estimatePromptContextUsage(content: string, contextWindowTokens?: number): string {
  const chars = content.length;
  const approxTokens = Math.max(1, Math.ceil(chars / APPROX_CHARS_PER_TOKEN));
  const denominator =
    typeof contextWindowTokens === "number" && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const ratio = (approxTokens / denominator) * 100;
  const ratioLabel = ratio < 0.1 ? "<0.1" : ratio.toFixed(1);
  const tokenLabel = new Intl.NumberFormat().format(approxTokens);
  const windowLabel = new Intl.NumberFormat().format(denominator);
  return `~${tokenLabel} tokens (${ratioLabel}% of ${windowLabel} ctx)`;
}
