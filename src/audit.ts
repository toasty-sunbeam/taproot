// Content audit (v0.4). Pure functions only: no KV, no Worker imports. The
// same logic backs the taproot_audit MCP tool (live KV) and
// `taproot audit --file <backup.json>` in cli.ts (an offline /backup export),
// so the two reports can't disagree.
//
// Background: before v0.4, taproot_remember with update_id and no `content`
// wrote `content: undefined`, which JSON.stringify drops. The record kept its
// gist, tags and timestamps but lost its text. This audit finds such records.
// It REPORTS ONLY and never repairs. James decides what to restore.

export type ContentState = "missing" | "empty" | "non_string";

export interface BackupCandidate {
  backup_key: string;
  updated_at: string | null;
  content_length: number;
  content_preview: string;
}

export interface ContentAuditRow {
  id: string;
  category: string;
  gist: string | null;
  updated_at: string | null;
  archived: boolean;
  content_state: ContentState;
  // Newest backup snapshot that still holds non-empty content for this id,
  // if any. A pointer for a manual restore, not something applied for you.
  backup_candidate: BackupCandidate | null;
}

export interface ContentAuditReport {
  status: "ok";
  scanned: number;
  affected: number;
  backups_searched: string[];
  rows: ContentAuditRow[];
  note: string;
}

// Raw record shape: anything at all could be in storage, so nothing is trusted.
type RawRecord = Record<string, unknown>;

export function contentState(content: unknown): ContentState | null {
  if (content === undefined || content === null) return "missing";
  if (typeof content !== "string") return "non_string";
  if (!content.trim()) return "empty";
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function auditContent(
  records: RawRecord[],
  snapshots: Array<{ key: string; records: unknown }>,
): ContentAuditReport {
  // Newest snapshot first, so the first usable hit per id is the most recent
  // good copy. Snapshot keys embed an ISO timestamp, so they sort by name.
  const ordered = [...snapshots].sort((a, b) => b.key.localeCompare(a.key));

  const rows: ContentAuditRow[] = [];
  for (const r of records) {
    const state = contentState(r.content);
    if (!state) continue;
    const id = String(r.id);

    let candidate: BackupCandidate | null = null;
    for (const snap of ordered) {
      if (!Array.isArray(snap.records)) continue;
      const hit = (snap.records as RawRecord[]).find(
        s => s && s.id === id && contentState(s.content) === null,
      );
      if (hit) {
        const c = hit.content as string;
        candidate = {
          backup_key: snap.key,
          updated_at: str(hit.updated_at),
          content_length: c.length,
          content_preview: c.length > 200 ? `${c.slice(0, 200)}…` : c,
        };
        break;
      }
    }

    const tags = r.tags;
    rows.push({
      id,
      category: String(r.category),
      gist: str(r.gist),
      updated_at: str(r.updated_at),
      archived: Array.isArray(tags) && tags.includes("_archive_pending"),
      content_state: state,
      backup_candidate: candidate,
    });
  }

  rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.id.localeCompare(b.id));

  return {
    status: "ok",
    scanned: records.length,
    affected: rows.length,
    backups_searched: ordered.map(s => s.key),
    rows,
    note:
      "Report only, nothing was changed. Records with a backup_candidate can be restored by re-sending that content with taproot_remember(update_id, content). Records without one need the text from the source conversation, or from an older /backup export.",
  };
}
