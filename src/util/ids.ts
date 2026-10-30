// Git object ids as the gate accepts them: full, lowercase, 40 hex digits for
// SHA-1 repositories or 64 for SHA-256 repositories. Abbreviations and refs are
// never accepted, because a short id can resolve to a different object later.

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isObjectId(s: string): boolean {
  return OBJECT_ID.test(s);
}
