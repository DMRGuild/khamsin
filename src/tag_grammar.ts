// Verbatim copy of the parent's lib/tag_grammar.ts — the newsgroup-tag
// grammar, config-free on purpose.

// Domain-shaped, lowercase: dot-separated alnum/hyphen labels. Single labels
// (`localhost`, bare newsgroup names) are fine; `:` is rejected so a port can
// never leak into a tag.
export const TAG_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const MAX_TAG_LEN = 100;
// Relay/PDS data is hostile input — cap how many tags a record can carry.
export const MAX_TAGS_PER_RECORD = 20;

/**
 * Normalizes a candidate tag (trim + lowercase) and validates it against the
 * tag grammar. Returns null for anything malformed or oversized. Grammar
 * only — the reserved-collection check is in kv.ts's normalizeTag.
 */
export function normalizeTagString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().toLowerCase();
  if (!tag || tag.length > MAX_TAG_LEN || !TAG_RE.test(tag)) return null;
  return tag;
}
