// Memory schema — matches the spec §5.2

export type MemoryCategory =
  | "identity"
  | "relationship"
  | "active_thread"
  | "episodic"
  | "error";

export type MemorySalience = "high" | "medium" | "low";

export type MemorySourceType =
  | "direct_observation"
  | "thread_summary"
  | "compression"
  | "manual_edit";

export interface MemorySource {
  type: MemorySourceType;
  conversation_id?: string;
  transcript_ref?: string;
  summary_ref?: string;
}

export interface Memory {
  id: string;
  category: MemoryCategory;
  content: string;
  salience: MemorySalience;
  created_at: string;
  updated_at: string;
  source: MemorySource;
  compression_level: number;
  linked_memories: string[];
  tags: string[];
}

// ─── Transcript types ─────────────────────────────────────────────────────────

export interface Transcript {
  id: string;
  title: string | null;
  content: string;
  conversation_date: string | null;
  created_at: string;
}

export interface TranscriptRow {
  id: string;
  title: string | null;
  conversation_date: string | null;
  created_at: string;
  excerpt: string;
}
