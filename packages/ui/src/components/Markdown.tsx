import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { cn } from '../lib/utils';

/**
 * Transcript prose, rendered.
 *
 * Claude writes markdown, and the transcript view used to print it raw: a table
 * came out as a wall of pipes that rewrapped into nonsense, code fences kept
 * their backticks, and lists lost their shape.
 *
 * Everything stays monospaced and terminal-sized on purpose — this view is a
 * transcript, not a document, and headings that balloon to 2rem would wreck the
 * line rhythm the gutter depends on. What the markdown buys is *structure*: a
 * real table that can scroll instead of wrapping, a code block that doesn't
 * rewrap, a list that indents.
 *
 * Raw HTML is deliberately not enabled (no rehype-raw). Transcripts quote files,
 * web pages and command output, none of which should be able to inject markup
 * into the dashboard. react-markdown escapes it and sanitizes link targets by
 * default; keep it that way.
 */
const COMPONENTS: Components = {
  // Tables scroll inside their own box. Terminal-width columns of numbers are
  // exactly what wrapping destroys, and the panel is often narrow.
  // `border-current` rather than a palette colour: cells inherit the turn's own
  // text colour — including its alpha — so the grid sits at exactly the weight
  // of the text it contains instead of at a fixed grey that reads as heavier in
  // a user turn and lighter in an assistant one.
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-current px-1.5 py-0.5 text-left font-semibold bg-muted/40">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-current px-1.5 py-0.5 align-top">{children}</td>
  ),

  // A fenced block keeps its own whitespace and scrolls; inline code just gets
  // a tint, since the surrounding text is already monospaced.
  code: ({ className, children }) => {
    const fenced = /language-/.test(className ?? '');
    if (!fenced) {
      return <code className="px-1 rounded bg-muted/60 text-foreground">{children}</code>;
    }
    return (
      <code className="block p-2 my-1 rounded-md bg-black/40 border border-border overflow-x-auto whitespace-pre">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,

  // Tight spacing throughout: the default margins are sized for documents and
  // would put a blank line between every paragraph of a conversation.
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 pl-2 border-l-2 border-border text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  // Same size as the body, distinguished by weight and colour rather than
  // scale — see the note above about line rhythm.
  h1: ({ children }) => <div className="mt-2 mb-1 font-bold text-foreground">{children}</div>,
  h2: ({ children }) => <div className="mt-2 mb-1 font-bold text-foreground">{children}</div>,
  h3: ({ children }) => <div className="mt-1.5 mb-0.5 font-semibold text-foreground">{children}</div>,
  h4: ({ children }) => <div className="mt-1.5 mb-0.5 font-semibold text-foreground">{children}</div>,
  h5: ({ children }) => <div className="mt-1.5 mb-0.5 font-semibold text-foreground">{children}</div>,
  h6: ({ children }) => <div className="mt-1.5 mb-0.5 font-semibold text-foreground">{children}</div>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    // leading-snug rather than the browser default 1.5: matches the line rhythm
    // the timestamp gutter is spaced to, while giving prose the same extra air
    // as the rest of the transcript.
    <div className={cn('leading-snug', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
