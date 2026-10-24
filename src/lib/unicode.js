/**
 * Unicode tag characters: the whole Tags block, U+E0000-U+E007F. They render
 * invisibly and are a documented steganographic channel for smuggling hidden
 * instructions past human review. One pattern shared by every check that scans
 * for them, so the checks cannot drift apart on what counts as a tag character.
 */
export const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/u;
