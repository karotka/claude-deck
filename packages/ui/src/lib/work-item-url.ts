/**
 * Where a work item key points.
 *
 * The tracker's own URL wins whenever there is one: only it knows its format,
 * and it has been to the server to find out. The template is the fallback for
 * the far commoner case of somebody who has told the dashboard where Jira is
 * but has not given it a token — a key should still be clickable then, since
 * linking needs an address and nothing else.
 *
 * The key is encoded. It reaches here from a transcript, and a template puts
 * it straight into a URL.
 */
export function workItemUrl(
  tag: string,
  template: string | undefined,
  trackerUrl?: string | null,
): string | null {
  if (trackerUrl) return trackerUrl;
  if (!template || !template.includes('{key}')) return null;
  return template.replace('{key}', encodeURIComponent(tag));
}

/**
 * Replace tracker links in a preview with the key they point at.
 *
 * A pasted ticket URL is sixty characters of host and path around the eight
 * that mean anything, and in a one-line preview it crowds out the sentence it
 * was pasted into. The key is what a person reads it for.
 *
 * Driven by the tag pattern rather than a configured address, so it works for
 * whatever tracker a URL came from — the test is that a URL's last path
 * segment is a key, which is exactly when the rest of it is scaffolding.
 */
export function shortenItemLinks(text: string, tagPattern: string | undefined): string {
  if (!text || !tagPattern) return text;
  let key: RegExp;
  try {
    key = new RegExp(`https?://\\S*?/(${tagPattern})(?![A-Za-z0-9-])\\S*`, 'g');
  } catch {
    // A pattern from configuration; a bad one should cost the shortening, not
    // the preview.
    return text;
  }
  return text.replace(key, '$1');
}

/**
 * Turn bare ticket keys in prose into markdown links.
 *
 * A transcript is full of keys nobody can click — a session that opened six
 * tickets names all six and offers no way to any of them. Rewriting the text
 * before it is rendered is enough, since the renderer already makes links out
 * of markdown and nothing else.
 *
 * Deliberately conservative about what it will touch. A key inside an existing
 * link, or inside code, is left alone: the first is already a link and the
 * second is usually a filename or a branch, where a link would be wrong.
 */
export function linkifyItemKeys(
  text: string,
  tagPattern: string | undefined,
  template: string | undefined,
): string {
  if (!text || !tagPattern || !template || !template.includes('{key}')) return text;

  let pattern: RegExp;
  try {
    // Split on the things to leave alone, so the key pattern only ever runs
    // over plain prose: fenced blocks, inline code, and existing links.
    pattern = new RegExp(
      `(\`\`\`[\\s\\S]*?\`\`\`|\`[^\`\n]*\`|\\[[^\\]]*\\]\\([^)]*\\)|https?://\\S+)`
      + `|(?<![A-Za-z0-9-])(${tagPattern})(?![A-Za-z0-9-])`,
      'g',
    );
  } catch {
    return text;
  }

  return text.replace(pattern, (match, protectedRun, key) => {
    if (protectedRun) return protectedRun;
    return `[${key}](${template.replace('{key}', encodeURIComponent(key))})`;
  });
}
