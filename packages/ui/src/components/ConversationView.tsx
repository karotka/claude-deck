import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { fetchMessages, type ParsedMessage } from '../lib/api';
import { formatTokens } from '../lib/utils';
import {
  summarizeToolInput,
  normalizeToolResult,
  summarizeToolResult,
  formatSystemEvent,
  mergeTurns,
} from '../lib/transcript';
import { Markdown } from './Markdown';

const STICK_THRESHOLD_PX = 50;
const NEAR_TOP_PX = 200;
const POLL_INTERVAL_MS = 3000;
/** Turns fetched on first paint and per "load older" step. */
const PAGE_SIZE = 300;
/** Turns re-fetched on each poll — enough to catch anything newly appended. */
const TAIL_SIZE = 60;
const SHOW_SYSTEM_KEY = 'claude-monitor-transcript-system';
const SHOW_TOOLS_KEY = 'claude-monitor-transcript-tools';

type ContentBlock = NonNullable<ParsedMessage['content']>[number];

function loadToggle(key: string): boolean {
  // Both filters default on — the point of this view is that nothing is hidden.
  return localStorage.getItem(key) !== 'false';
}

function oldestSeq(turns: ParsedMessage[]): number | null {
  return turns.length > 0 && turns[0].seq != null ? turns[0].seq : null;
}

function newestSeq(turns: ParsedMessage[]): number | null {
  const last = turns[turns.length - 1];
  return last?.seq ?? null;
}

export function ConversationView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<ParsedMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showSystem, setShowSystem] = useState(() => loadToggle(SHOW_SYSTEM_KEY));
  const [showTools, setShowTools] = useState(() => loadToggle(SHOW_TOOLS_KEY));

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const loadingOlderRef = useRef(false);
  // Scroll offsets captured just before older turns are prepended, so the
  // viewport can be pinned to the same content afterwards.
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // Read by the scroll handler, which would otherwise close over stale state.
  const stateRef = useRef({ turns, total });
  stateRef.current = { turns, total };

  /** Fetch the newest `TAIL_SIZE` turns and fold them into what's on screen. */
  const pollTail = useCallback(async () => {
    try {
      const data = await fetchMessages(sessionId, 0, TAIL_SIZE);
      const incoming = [...data.messages].reverse(); // server returns newest-first
      setTotal(data.total);
      setTurns(prev => {
        // If more than a page landed between polls, the tail no longer touches
        // what we have — start again from the tail rather than leave a hole.
        const prevNewest = newestSeq(prev);
        const incomingOldest = oldestSeq(incoming);
        if (prevNewest != null && incomingOldest != null && incomingOldest > prevNewest + 1) {
          return incoming;
        }
        return mergeTurns(prev, incoming);
      });
    } catch { /* transient — the next poll retries */ }
  }, [sessionId]);

  /** Prepend the page of turns immediately older than the oldest one loaded. */
  const loadOlder = useCallback(async (pageSize = PAGE_SIZE) => {
    if (loadingOlderRef.current) return;
    const { turns: current, total: knownTotal } = stateRef.current;
    const min = oldestSeq(current);
    if (min == null || min <= 0) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      // Responses are newest-first, so the turn just older than `min` sits at
      // index `total - min`. Deriving the offset from seq keeps paging correct
      // even when the session grows between requests.
      const offset = Math.max(0, knownTotal - min);
      const data = await fetchMessages(sessionId, offset, pageSize);
      const older = [...data.messages].reverse();

      // Merge against the turns as of now — a poll may have committed during the
      // await. Arming the anchor only when the merge actually adds something
      // keeps a no-op page from leaving a stale anchor for the next update.
      const latest = stateRef.current.turns;
      const merged = mergeTurns(latest, older);
      setTotal(data.total);
      if (merged === latest) return;

      const el = scrollRef.current;
      if (el) anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      setTurns(merged);
    } catch {
      anchorRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [sessionId]);

  const loadEverything = useCallback(async () => {
    const min = oldestSeq(stateRef.current.turns);
    if (min == null || min <= 0) return;
    // Turns 0..min-1 are the entire remaining history, so one page covers it.
    await loadOlder(min);
  }, [loadOlder]);

  // Reset and load the newest page whenever the session changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTurns([]);
    setTotal(0);
    setExpanded(new Set());
    userScrolledUpRef.current = false;
    anchorRef.current = null;
    setShowJumpButton(false);

    fetchMessages(sessionId, 0, PAGE_SIZE)
      .then(data => {
        if (cancelled) return;
        setTurns([...data.messages].reverse());
        setTotal(data.total);
      })
      .catch(() => { /* rendered as the empty state */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const id = setInterval(pollTail, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pollTail]);

  // Either pin the viewport to the turn it was on (after a prepend) or stick to
  // the bottom (after new turns arrive). Layout effect so neither flickers.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      return;
    }
    if (!userScrolledUpRef.current) el.scrollTop = el.scrollHeight;
    else setShowJumpButton(true);
  }, [turns]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < STICK_THRESHOLD_PX;
    userScrolledUpRef.current = !atBottom;
    if (atBottom) setShowJumpButton(false);
    if (el.scrollTop < NEAR_TOP_PX) void loadOlder();
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    userScrolledUpRef.current = false;
    setShowJumpButton(false);
  };

  const toggleBlock = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleFilter = (key: string, set: (v: boolean) => void) => (value: boolean) => {
    localStorage.setItem(key, String(value));
    set(value);
  };

  if (loading) {
    return <div className="text-[13px] text-muted-foreground p-3 font-mono">Loading transcript...</div>;
  }

  if (turns.length === 0) {
    return <div className="text-[13px] text-muted-foreground p-3 font-mono">No messages.</div>;
  }

  const min = oldestSeq(turns);
  const allLoaded = min == null ? turns.length >= total : min <= 0;

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="font-mono text-[13px] h-full overflow-y-auto"
      >
        <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap px-3 py-1.5 bg-background/95 backdrop-blur border-b border-border text-[11px] text-muted-foreground">
          <span>
            showing {turns.length.toLocaleString()} of {total.toLocaleString()} turns
          </span>
          {!allLoaded && (
            <>
              <button
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="px-2 py-0.5 rounded-md bg-muted border border-border hover:bg-accent disabled:opacity-50"
              >
                {loadingOlder ? 'Loading…' : 'Load older'}
              </button>
              <button
                onClick={() => void loadEverything()}
                disabled={loadingOlder}
                className="px-2 py-0.5 rounded-md bg-muted border border-border hover:bg-accent disabled:opacity-50"
                title="Load the entire transcript back to the first message"
              >
                Load all
              </button>
            </>
          )}
          {allLoaded && <span className="text-muted-foreground/50">start of transcript</span>}
          <FilterToggle
            label="system events"
            checked={showSystem}
            onChange={toggleFilter(SHOW_SYSTEM_KEY, setShowSystem)}
          />
          <FilterToggle
            label="tool calls"
            checked={showTools}
            onChange={toggleFilter(SHOW_TOOLS_KEY, setShowTools)}
          />
          <button onClick={() => void pollTail()} className="ml-auto hover:text-foreground">
            reload
          </button>
        </div>

        <div className="p-3 space-y-0.5">
          {turns.map((turn, i) => (
            <Turn
              key={turn.seq ?? `${turn.type}-${turn.timestamp}-${i}`}
              turn={turn}
              expanded={expanded}
              onToggle={toggleBlock}
              showSystem={showSystem}
              showTools={showTools}
            />
          ))}
        </div>
      </div>

      {showJumpButton && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 right-4 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

function FilterToggle({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-border h-3 w-3"
      />
      {label}
    </label>
  );
}

const GUTTER = 'w-[58px] shrink-0 text-muted-foreground/30 select-none tabular-nums';

function Turn({
  turn, expanded, onToggle, showSystem, showTools,
}: {
  turn: ParsedMessage;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  showSystem: boolean;
  showTools: boolean;
}) {
  const isSystemEvent =
    turn.type === 'system' || turn.type === 'permission-mode' || turn.type === 'file-history-snapshot';

  if (isSystemEvent) {
    if (!showSystem) return null;
    return (
      <div className="flex items-center gap-2 py-1 text-muted-foreground/35">
        <span className="h-px flex-1 bg-border" />
        <span className="whitespace-pre-wrap break-all text-[11px]">{formatSystemEvent(turn)}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // Keep the original block index in the key so expansion survives a filter toggle.
  const rows = (turn.content ?? [])
    .map((block, index) => ({ block, index }))
    .filter(({ block }) =>
      block.type === 'text' ? (block.text ?? '').trim().length > 0 : showTools,
    );
  if (rows.length === 0) return null;

  const ts = turn.timestamp
    ? new Date(turn.timestamp).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : '';
  const isUser = turn.type === 'user';
  const tokens = turn.usage?.outputTokens ? formatTokens(turn.usage.outputTokens) : '';

  return (
    <div className="py-0.5">
      {rows.map(({ block, index }, i) => {
        const blockKey = `${turn.seq ?? turn.timestamp}:${index}`;
        return (
          <Block
            key={blockKey}
            block={block}
            isUser={isUser}
            // Merged turns share one timestamp; stamp the first row only.
            stamp={i === 0 ? ts : ''}
            tokens={i === 0 ? tokens : ''}
            expanded={expanded.has(blockKey)}
            onToggle={() => onToggle(blockKey)}
          />
        );
      })}
    </div>
  );
}

function Block({
  block, isUser, stamp, tokens, expanded, onToggle,
}: {
  block: ContentBlock;
  isUser: boolean;
  stamp: string;
  tokens: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (block.type === 'tool_use') {
    return (
      <>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full gap-2 text-left leading-snug rounded hover:bg-muted/40"
        >
          <span className={GUTTER}>{stamp}</span>
          <span className="text-blue-400/70 shrink-0">
            {expanded ? '▾' : '▸'} {block.name}
          </span>
          <span className="text-muted-foreground/50 truncate">
            {summarizeToolInput(block.name ?? '', block.input)}
          </span>
        </button>
        {expanded && (
          <Expansion>{JSON.stringify(block.input ?? null, null, 2)}</Expansion>
        )}
      </>
    );
  }

  if (block.type === 'tool_result') {
    const text = normalizeToolResult(block.content);
    return (
      <>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full gap-2 text-left leading-snug rounded hover:bg-muted/40"
        >
          <span className={GUTTER}>{stamp}</span>
          <span className="text-muted-foreground/45 truncate">
            {expanded ? '▾' : '⎿'} {summarizeToolResult(text)}
          </span>
        </button>
        {expanded && <Expansion>{text}</Expansion>}
      </>
    );
  }

  const text = block.text ?? '';
  if (isUser) {
    return (
      <div className="flex gap-2 leading-snug py-1">
        <span className={GUTTER}>{stamp}</span>
        <span className="text-green-400 font-bold shrink-0">&gt;</span>
        <Markdown className="text-green-300 break-words min-w-0" >{text}</Markdown>
      </div>
    );
  }

  return (
    <div className="flex gap-2 leading-snug py-0.5">
      <span className={GUTTER}>{stamp}</span>
      <span className="min-w-0 flex-1">
        {tokens && <span className="text-muted-foreground/40 mr-2">[{tokens}]</span>}
        <Markdown className="text-foreground/80 break-words inline-block align-top w-full">
          {text}
        </Markdown>
      </span>
    </div>
  );
}

function Expansion({ children }: { children: string }) {
  return (
    <pre className="ml-[66px] my-1 p-2 rounded-md bg-black/40 border border-border text-[12px] text-muted-foreground whitespace-pre-wrap break-words max-h-[420px] overflow-auto">
      {children}
    </pre>
  );
}
