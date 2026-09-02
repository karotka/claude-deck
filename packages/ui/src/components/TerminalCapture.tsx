import { useState, useEffect, useRef } from 'react';
import { splitPane } from '../lib/terminal';
import { parseAnsi, type AnsiLine } from '../lib/ansi';
import { cn } from '../lib/utils';
import { uploadAttachment } from '../lib/api';
import { useAppConfig } from '../hooks/useAppConfig';

interface Props {
  sessionId: string;
  canInteract: boolean;
  /** Switches the detail page to the Conversation tab, where the full history lives. */
  /**
   * How often to re-read the pane. VM sessions poll faster than local ones:
   * their frames are streamed and served from memory, so a poll is a localhost
   * round trip rather than a `docker exec`, and the slower cadence was most of
   * what made a remote keystroke feel laggy.
   */
  pollMs?: number;
}

const DEFAULT_LINES = 1000;
const MAX_LINES = 50000;
const DEFAULT_POLL_MS = 2000;

export function TerminalCapture({
  sessionId,
  canInteract,
  pollMs = DEFAULT_POLL_MS,
}: Props) {
  const storageKey = `terminal-input:${sessionId}`;
  const [output, setOutput] = useState('');
  const [input, setInput] = useState<string>(() => sessionStorage.getItem(storageKey) ?? '');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Files dragged or pasted onto the pane. They become paths in the prompt —
  // a terminal carries text, so an image has to arrive as somewhere to look.
  const [dropping, setDropping] = useState(false);
  const [uploading, setUploading] = useState(false);
  const appConfig = useAppConfig();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [lines, setLines] = useState(DEFAULT_LINES);
  // True once tmux returns fewer lines than we asked for — i.e. we've reached
  // the actual top of the pane's scrollback, so raising `lines` can't reveal
  // more. Claude's full-screen TUI uses the alternate screen buffer, which
  // tmux doesn't accumulate into scrollback, so this is hit almost immediately.
  const [scrollbackExhausted, setScrollbackExhausted] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    setInput(sessionStorage.getItem(storageKey) ?? '');
  }, [storageKey]);

  // Reset history depth when switching sessions.
  useEffect(() => {
    setLines(DEFAULT_LINES);
    setScrollbackExhausted(false);
    userScrolledUpRef.current = false;
  }, [sessionId]);

  const updateInput = (value: string) => {
    setInput(value);
    if (value) sessionStorage.setItem(storageKey, value);
    else sessionStorage.removeItem(storageKey);
  };

  const fetchCapture = async (overrideLines?: number) => {
    try {
      const n = overrideLines ?? lines;
      const cols = computeCols(outputRef.current);
      const colsQ = cols ? `&cols=${cols}` : '';
      const res = await fetch(`/api/sessions/${sessionId}/capture?lines=${n}${colsQ}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed to capture');
        return;
      }
      const data = await res.json();
      setOutput(data.content);
      // If tmux gave back fewer lines than requested, the pane has no more
      // scrollback to offer — clicking "Load more" again would change nothing.
      setScrollbackExhausted(countLines(data.content) < n);
      setError(null);
    } catch {
      setError('Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCapture();
    const id = setInterval(fetchCapture, pollMs);
    return () => clearInterval(id);
  }, [sessionId, lines, pollMs]);

  useEffect(() => {
    if (outputRef.current && !userScrolledUpRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleOutputScroll = () => {
    const el = outputRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 50;
  };

  const loadMore = () => {
    setLines(prev => Math.min(prev * 2, MAX_LINES));
    // Keep current scroll position when more history arrives.
    userScrolledUpRef.current = true;
  };

  /**
   * Render a pane returned by the send endpoint. Remote sessions read the pane
   * back in the same round trip, so there is nothing to wait for; local ones
   * return no pane and fall back to a scheduled re-read.
   */
  const applyResponsePane = async (res: Response): Promise<boolean> => {
    try {
      const data = await res.clone().json();
      if (typeof data?.content !== 'string') return false;
      setOutput(data.content);
      setError(null);
      return true;
    } catch {
      return false;
    }
  };

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input }),
      });
      if (res.ok) {
        updateInput('');
        // A remote send returns the pane it produced; rendering it immediately
        // is what removes the poll-interval wait from a keystroke.
        if (!(await applyResponsePane(res))) setTimeout(fetchCapture, 500);
      } else {
        // Keep the text in the box so a failed send isn't lost, and tell the
        // user why instead of leaving it looking half-sent.
        const data = await res.json().catch(() => ({}));
        setSendError(data.error ?? `Send failed (${res.status})`);
      }
    } catch {
      setSendError('Send failed — could not reach the server.');
    }
    setSending(false);
  };

  const sendKey = async (key: string) => {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.ok && !(await applyResponsePane(res))) setTimeout(fetchCapture, 300);
    } catch { /* ignore */ }
    setSending(false);
  };

  // Send the buffered input followed by a Tab keystroke (no Enter), so the
  // session sees the partial text and lets Claude's inline suggestion accept.
  const sendTab = async () => {
    if (sending) return;
    setSending(true);
    try {
      if (input.length > 0) {
        const res = await fetch(`/api/sessions/${sessionId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input, noEnter: true }),
        });
        if (!res.ok) { setSending(false); return; }
        updateInput('');
      }
      const tabRes = await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'Tab' }),
      });
      if (!(await applyResponsePane(tabRes))) setTimeout(fetchCapture, 300);
    } catch { /* ignore */ }
    setSending(false);
  };

  // Land in the prompt, the way opening a terminal does.
  //
  // `loading` is in the deps for a reason: on mount the panel renders
  // "Connecting to terminal…" instead of the prompt, so the input isn't in the
  // DOM yet and there is nothing to focus. Without waiting for the first
  // capture, this ran once against a null ref and did nothing at all.
  useEffect(() => {
    if (!loading && canInteract) inputRef.current?.focus();
  }, [loading, canInteract, sessionId]);

  /**
   * Take dropped or pasted files and put their paths in the prompt.
   *
   * Claude Code reads an image from a path, so this is the same thing you would
   * do by hand — save the file, type where it went — without the picker. The
   * paths are appended rather than sent: you almost always want to say
   * something about the image you just dropped.
   */
  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;

    // Checked here as well as on the server: an oversized body is refused at
    // the transport layer, which arrives as a reset connection and no message
    // at all. The limit comes from the server so the two cannot drift.
    const limit = appConfig?.maxAttachmentBytes;
    const tooBig = limit ? files.find(f => f.size > limit) : undefined;
    if (tooBig && limit) {
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
      setSendError(`${tooBig.name} is ${mb(tooBig.size)}; the limit is ${mb(limit)}.`);
      return;
    }

    setUploading(true);
    setSendError(null);
    try {
      const paths: string[] = [];
      for (const file of files) {
        const { path } = await uploadAttachment(sessionId, file);
        paths.push(path);
      }
      updateInput([input.trimEnd(), ...paths].filter(Boolean).join(' ') + ' ');
      inputRef.current?.focus();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'could not attach the file');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    void attachFiles([...e.dataTransfer.files]);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    // Only intercept a paste that carries files. A text paste is a text paste.
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    void attachFiles(files);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl-C interrupts the session rather than copying — there is nothing to
    // copy from an empty prompt, and interrupting is the thing you need in a
    // hurry. With a selection, let the browser copy it.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      const selected = e.currentTarget.selectionStart !== e.currentTarget.selectionEnd;
      if (!selected) { e.preventDefault(); sendKey('C-c'); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.length === 0) sendKey('Enter');
      else handleSend();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      // Shift+Tab cycles Claude Code's permission mode, and goes through as a
      // bare key: unlike Tab, it is not accepting a suggestion, so there is no
      // buffered text to flush first.
      if (e.shiftKey) sendKey('BTab');
      else sendTab();
      return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); sendKey('Up'); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); sendKey('Down'); return; }
    if (e.key === 'Escape') { e.preventDefault(); sendKey('Escape'); return; }
    // Left/Right move the caret while there is text to move through, and drive
    // the TUI's own selection when there isn't. The nav buttons used to be the
    // only way to send these; the prompt is now the only input there is.
    if (input.length === 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      sendKey(e.key === 'ArrowLeft' ? 'Left' : 'Right');
    }
  };

  const { body, status } = splitPane(output);

  if (loading) {
    return <div className="text-sm text-muted-foreground p-4">Connecting to terminal...</div>;
  }

  // Only surrender the whole panel when there's nothing to show. Once a capture
  // has succeeded, a later failure is almost always a transient hiccup (a spawn
  // EAGAIN under host load), and replacing the pane with an error box makes the
  // view flicker between content and error at the poll interval. Keep the last
  // good frame and mark it stale instead.
  if (error && !output) {
    return (
      <div className="p-4">
        <div className="text-sm text-yellow-400 bg-yellow-950/20 border border-yellow-800 rounded-md p-3">
          {error}
        </div>
      </div>
    );
  }

  const atMaxLines = lines >= MAX_LINES;
  // No point letting the user keep clicking once tmux has no more scrollback.
  const canLoadMore = !atMaxLines && !scrollbackExhausted;

  return (
    <div
      className={cn(
        'flex flex-col h-full relative',
        dropping && 'outline outline-2 outline-primary/60 outline-offset-[-2px]',
      )}
      onDragOver={e => { e.preventDefault(); setDropping(true); }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false); }}
      onDrop={handleDrop}
    >
      {dropping && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 text-sm text-muted-foreground pointer-events-none">
          Drop to attach — the path goes in the prompt
        </div>
      )}
      {/* Only shown when it has something to offer. The bar used to be
          permanent and mostly announced dead ends — a disabled "Full scrollback
          shown" button and a note explaining why a terminal has no history —
          which is a strip of apology above the thing you came to look at.
          Claude's TUI runs on the alternate screen, so tmux keeps no scrollback
          for it; that is how terminals work, not news to deliver every time. */}
      {(canLoadMore || error) && (
        <div className="flex items-center justify-between gap-3 px-3 py-1 border-b border-border bg-muted/30 text-[10px] text-muted-foreground">
          {canLoadMore ? (
            <button
              type="button"
              onClick={loadMore}
              className="shrink-0 px-2 py-0.5 rounded-md bg-muted border border-border hover:bg-accent"
              title="Load more terminal scrollback"
            >
              Load more history
            </button>
          ) : <span />}
          {error && (
            <span className="text-yellow-500/90 truncate" title={error}>
              reconnecting — showing last frame
            </span>
          )}
        </div>
      )}
      <pre
        ref={outputRef}
        onScroll={handleOutputScroll}
        // Same type and colour as the transcript beside it. The green-on-black
        // was a terminal costume: Claude Code's own TUI paints its colours
        // through ANSI, which comes through anyway, so the only thing a green
        // foreground did was tint everything the TUI left uncoloured.
        // Tighter than the transcript's leading on purpose: this is a rendered
        // terminal, and the TUI draws box characters that want to join up
        // between rows rather than sit in bands of air.
        className="flex-1 overflow-auto p-4 text-[13px] leading-tight font-mono text-foreground/80 whitespace-pre"
      >
        {parseAnsi(body).map((line, i) => (
          <AnsiRow key={i} line={line} />
        ))}
      </pre>

      {canInteract ? (
        // Shaped like the bottom of the TUI itself: a boxed prompt, then the
        // status Claude Code prints under it. The status is parsed from the
        // live pane rather than derived here, so it always says what the
        // session says — model, context, usage, mode, subagents and all.
        <div className="flex flex-col px-4 pb-3 font-mono text-[13px] leading-tight">
          {sendError && (
            <div className="mb-2 text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md px-3 py-1.5">
              {sendError}
            </div>
          )}
          <div
            onClick={() => inputRef.current?.focus()}
            className="flex items-start gap-2 border border-border/70 rounded px-3 py-1.5 focus-within:border-foreground/40 cursor-text"
          >
            <span className="text-foreground/50 select-none" aria-hidden>&gt;</span>
            <textarea
              ref={inputRef}
              rows={1}
              // Grows with the text instead of scrolling a one-line box: a
              // prompt you cannot read back is a prompt you cannot check before
              // sending. Capped so a pasted wall of text can't swallow the pane
              // it belongs to.
              style={{ maxHeight: '12rem' }}
              onInput={e => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
              }}
              value={input}
              onChange={e => updateInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onPaste={handlePaste}
              placeholder={
                uploading ? 'Attaching…' : sending ? 'Sending…' : 'Type a message'
              }
              // text-base below sm keeps iOS from zooming the page on focus.
              className="flex-1 min-w-0 bg-transparent resize-none outline-none text-base sm:text-[13px] font-mono placeholder:text-foreground/25"
            />
          </div>
          {status.length > 0 && (
            <div className="mt-1.5 whitespace-pre-wrap break-words">
              {parseAnsi(status.join('\n')).map((line, i) => (
                <AnsiRow key={i} line={line} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="p-3 border-t border-border text-xs text-yellow-400 bg-yellow-950/10">
          This session is observe-only. To interact, restart it in a tmux session.
        </div>
      )}
    </div>
  );
}

// Count rendered rows in a captured pane. A single trailing newline from
// capture-pane doesn't represent a real extra line, so ignore it.
function countLines(content: string): number {
  if (!content) return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.split('\n').length;
}

// Measure visible char width by injecting a sample string into the same
// element, so tmux pane width matches what the UI actually displays.
function computeCols(el: HTMLElement | null): number | null {
  if (!el) return null;
  const innerWidth = el.clientWidth - getHorizontalPadding(el);
  if (innerWidth <= 0) return null;
  const probe = document.createElement('span');
  probe.textContent = 'X'.repeat(100);
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  el.appendChild(probe);
  const probeWidth = probe.getBoundingClientRect().width;
  el.removeChild(probe);
  if (probeWidth <= 0) return null;
  const charWidth = probeWidth / 100;
  return Math.max(40, Math.floor(innerWidth / charWidth));
}

function getHorizontalPadding(el: HTMLElement): number {
  const s = window.getComputedStyle(el);
  return parseFloat(s.paddingLeft || '0') + parseFloat(s.paddingRight || '0');
}

// Trailing punctuation often hugs a URL in prose (e.g. "see https://x.com/foo.")
// but isn't part of it. Strip these before turning the URL into an anchor.
const URL_RE = /https?:\/\/[^\s<>"`']+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>'"]+$/;

/**
 * One row of the pane, with the terminal's own colour.
 *
 * Runs come from the SGR sequences `capture-pane -e` preserved, so this shows
 * what the terminal shows rather than a guess made from the glyph at the start
 * of the line. A row with nothing on it still needs a box, or the pane
 * collapses wherever the TUI left a blank.
 */
function AnsiRow({ line }: { line: AnsiLine }) {
  if (line.spans.length === 0) return <div>&nbsp;</div>;
  return (
    <div>
      {line.spans.map((span, i) => (
        <span key={i} style={span.style}>{linkify(span.text)}</span>
      ))}
    </div>
  );
}

function linkify(text: string): React.ReactNode {
  if (!text) return text;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  let key = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    let url = match[0];
    let end = match.index + url.length;
    const trail = url.match(TRAILING_PUNCT_RE);
    if (trail) {
      url = url.slice(0, url.length - trail[0].length);
      end -= trail[0].length;
    }
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <a
        key={key++}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-cyan-400 underline hover:text-cyan-300"
      >
        {url}
      </a>,
    );
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

