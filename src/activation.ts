// Activation scoring for taproot_recall.
//
// Modeled loosely on ACT-R's base-level activation equation: memories that
// are recalled often and recently are more "active" than ones that sit
// untouched. We combine that with salience (how important the memory was
// judged to be at write time) and query relevance (does this memory look
// like what's being asked for right now).
//
// All tunable weights live in ACTIVATION_CONFIG below so they can be
// adjusted without hunting through handler code.

import type { Memory, MemorySalience } from "./types.js";

export const ACTIVATION_CONFIG = {
  // Relative contribution of each scoring dimension to the final score.
  BASE_LEVEL_WEIGHT: 1.0,
  SALIENCE_WEIGHT: 1.0,
  RELEVANCE_WEIGHT: 2.5,

  // Base-level activation = ln(retrieval_count + 1) * recency_decay.
  // recency_decay is a power-law function of days since last touch:
  // (days_since + 1) ^ -RECENCY_DECAY_EXPONENT. Higher exponent = memories
  // fall off faster after their last retrieval.
  RECENCY_DECAY_EXPONENT: 0.5,

  // Never-retrieved memories would score 0 on the base-level term (ln(1) = 0)
  // and get buried under anything that's ever been touched, regardless of
  // how relevant or salient they are. Give them this flat floor instead.
  NOVELTY_FLOOR: 0.6,

  // Salience → numeric weight.
  SALIENCE_SCORE: { high: 1.0, medium: 0.6, low: 0.3 } as Record<MemorySalience, number>,

  // Relevance is token-overlap between the query and the memory. A term
  // found in search_keywords/tags/gist counts at full weight; a term found
  // only in the full content counts at a reduced weight (content is noisier
  // and less curated than the keyword fields).
  RELEVANCE_KEYWORD_WEIGHT: 1.0,
  RELEVANCE_CONTENT_WEIGHT: 0.35,
} as const;

// Deliberately simple suffix-stripping stemmer — good enough to match
// "commission" / "commissions" or "paint" / "painting" without pulling in a
// real NLP dependency for v0.2.
function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).map(stem);
}

export function relevanceScore(query: string, memory: Memory): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;

  const keywordTokens = new Set([
    ...(memory.search_keywords ?? []).flatMap(tokenize),
    ...memory.tags.flatMap(tokenize),
    ...tokenize(memory.gist ?? ""),
  ]);
  const contentTokens = new Set(tokenize(memory.content));

  let keywordHits = 0;
  let contentOnlyHits = 0;
  for (const t of queryTokens) {
    if (keywordTokens.has(t)) keywordHits++;
    else if (contentTokens.has(t)) contentOnlyHits++;
  }

  return (
    (keywordHits / queryTokens.size) * ACTIVATION_CONFIG.RELEVANCE_KEYWORD_WEIGHT +
    (contentOnlyHits / queryTokens.size) * ACTIVATION_CONFIG.RELEVANCE_CONTENT_WEIGHT
  );
}

function recencyDecay(referenceIso: string, now: number): number {
  const referenceMs = new Date(referenceIso).getTime();
  const days = Math.max(0, (now - referenceMs) / 86_400_000);
  return Math.pow(days + 1, -ACTIVATION_CONFIG.RECENCY_DECAY_EXPONENT);
}

export function baseLevelActivation(memory: Memory, now: number): number {
  if (memory.retrieval_count <= 0) return ACTIVATION_CONFIG.NOVELTY_FLOOR;
  const reference = memory.last_retrieved ?? memory.created_at;
  return Math.log(memory.retrieval_count + 1) * recencyDecay(reference, now);
}

export function activationScore(memory: Memory, query: string, now: number = Date.now()): number {
  const base = baseLevelActivation(memory, now) * ACTIVATION_CONFIG.BASE_LEVEL_WEIGHT;
  const salience = ACTIVATION_CONFIG.SALIENCE_SCORE[memory.salience] * ACTIVATION_CONFIG.SALIENCE_WEIGHT;
  const relevance = query.trim() ? relevanceScore(query, memory) * ACTIVATION_CONFIG.RELEVANCE_WEIGHT : 0;
  return base + salience + relevance;
}
