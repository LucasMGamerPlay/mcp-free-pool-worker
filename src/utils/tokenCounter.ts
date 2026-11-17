// Rough estimate: ~4 characters per token across the providers we use.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
