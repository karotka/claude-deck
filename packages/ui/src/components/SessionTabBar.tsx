import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Session } from '../lib/api';
import { visibleTabs, loadClosedTabs, saveClosedTabs, reorder, tabByStep } from '../lib/tabs';
import { RemoteDot } from './SourceBadge';
import { cn, truncate } from '../lib/utils';

/**
 * The dot, in the terms a person actually wants.
 *
 * "Running" and "idle" are the API's words and they mislead: a Claude Code
 * session is *idle* precisely when it is waiting for you, which is the state
 * you most want to spot, and *running* when it needs nothing. So the dot is
 * labelled by what it asks of you rather than by process state, and every one
 * carries that label as a tooltip — a colour nobody has a legend for says
 * nothing at all.
 */
const statusDot: Record<string, { className: string; label: string }> = {
  running: { className: 'bg-green-500', label: 'Working now' },
  idle: { className: 'bg-yellow-500', label: 'Waiting for you' },
  // Hollow, not grey-filled: a stopped session is an absence, and it should
  // recede rather than compete with the two that are live.
  stopped: { className: 'border border-muted-foreground/50', label: 'Not running' },
};

const NAMES_KEY = 'claude-monitor-tab-names';
const ORDER_KEY = 'claude-monitor-tab-order';

function loadJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') as T;
  } catch {
    return fallback;
  }
}

function defaultLabel(s: Session): string {
  // What the user called it, if they called it anything — nothing derived beats
  // a name someone chose.
  if (s.sessionName) return s.sessionName;
  // Otherwise the tag: the shortest true name a session has, and the server is
  // the only place that knows the naming rules that produce it.
  if (s.tag) return s.tag;
  if (s.firstUserMessage) {
    return truncate(s.firstUserMessage, 30);
  }
  const parts = s.projectPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || s.id.slice(0, 8);
}

/** Apply saved order, appending any new sessions at the end. */
function applyOrder(sessions: Session[], order: string[]): Session[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const result: Session[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s) {
      result.push(s);
      byId.delete(id);
    }
  }
  // Append sessions not in the saved order
  for (const s of byId.values()) {
    result.push(s);
  }
  return result;
}

interface Props {
  sessions: Session[];
  activeId: string;
  interactiveOnly?: boolean;
  notes?: Record<string, string>;
}

export function SessionTabBar({ sessions, activeId, interactiveOnly = false, notes }: Props) {
  const [tabNames, setTabNames] = useState(() => loadJson<Record<string, string>>(NAMES_KEY, {}));
  const [tabOrder, setTabOrder] = useState(() => loadJson<string[]>(ORDER_KEY, []));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => loadClosedTabs());
  const inputRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  /**
   * A vertical wheel scrolls the strip sideways.
   *
   * With the scrollbar hidden there is nothing left to drag, and a mouse with
   * no horizontal wheel would have no way to reach the tabs off the right edge
   * at all. A trackpad's own horizontal gesture arrives as deltaX and is left
   * to the browser.
   */
  const handleStripWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || e.deltaX !== 0 || e.deltaY === 0) return;
    if (el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
  };

  // Visiting a session reopens its tab. Without this a closed tab could only be
  // brought back by clearing storage — you would click it on the dashboard and
  // still not see it in the bar.
  useEffect(() => {
    setClosed(prev => {
      if (!prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.delete(activeId);
      saveClosedTabs(next);
      return next;
    });
  }, [activeId]);

  const visible = applyOrder(
    visibleTabs(sessions, { activeId, interactiveOnly, closed }),
    tabOrder,
  );

  // Auto-persist the full order so new sessions get pinned in place
  const visibleIds = visible.map(s => s.id);
  const orderStr = visibleIds.join(',');
  const savedStr = tabOrder.join(',');
  useEffect(() => {
    if (orderStr !== savedStr && visibleIds.length > 0) {
      setTabOrder(visibleIds);
      localStorage.setItem(ORDER_KEY, JSON.stringify(visibleIds));
    }
  }, [orderStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the open session's tab reachable. Landing on a session whose tab sits
  // off the right edge used to leave the strip showing someone else's.
  useEffect(() => {
    const el = stripRef.current;
    const tab = el?.querySelector<HTMLElement>('[data-active="true"]');
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  /**
   * ⌘⇧← / ⌘⇧→ move between tabs, in the order the strip shows them.
   *
   * On `window` and without excusing text fields, which is the unusual part.
   * The terminal's prompt is focused most of the time you are looking at a
   * session — that is the point of it — so a shortcut that stepped aside for
   * inputs would be dead exactly where it is wanted. The cost is the caret
   * selection those keys do inside the prompt; a one-line prompt has ⌘A and
   * shift+Home for that, and nothing else in the app can switch tabs from the
   * keyboard at all.
   *
   * Bare ⌘← / ⌘→ is left alone: that is browser history, and taking it would
   * be worse than not having this.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = tabByStep(orderStr.split(','), activeId, e.key === 'ArrowRight' ? 1 : -1);
      if (!next) return;
      e.preventDefault();
      navigate(`/session/${next}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orderStr, activeId, navigate]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const commitRename = (sessionId: string) => {
    const trimmed = editValue.trim();
    const updated = { ...tabNames };
    if (trimmed) {
      updated[sessionId] = trimmed;
    } else {
      delete updated[sessionId];
    }
    setTabNames(updated);
    localStorage.setItem(NAMES_KEY, JSON.stringify(updated));
    setEditingId(null);
  };

  const saveOrder = (ids: string[]) => {
    setTabOrder(ids);
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  };

  // Closes the tab, which is a local thing — it does not hide the session from
  // the dashboard. Those were the same action until people started closing
  // running sessions by accident and losing them from the board entirely; Hide
  // on the card is still there for when hiding is what you mean.
  const handleClose = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setClosed(prev => {
      const next = new Set(prev).add(sessionId);
      saveClosedTabs(next);
      return next;
    });
    if (sessionId === activeId) {
      const remaining = visible.filter(s => s.id !== sessionId);
      if (remaining.length > 0) {
        navigate(`/session/${remaining[0].id}`);
      } else {
        navigate('/');
      }
    }
  };

  /**
   * Reordering, on pointer events rather than HTML5 drag-and-drop.
   *
   * A tab is a link, and Chrome claims a drag that starts on one for itself:
   * it becomes a drag of the URL, to another window or the address bar, and
   * the drop never reaches the strip. That is why dragging a tab did nothing.
   * Pointer events have no such special case, and they also let the gesture
   * decide for itself whether it was a click or a drag — under the threshold
   * the link navigates as usual, over it nothing navigates at all.
   */
  const DRAG_THRESHOLD_PX = 4;
  const pressRef = useRef<{ id: string; x: number; el: HTMLElement } | null>(null);
  const draggedRef = useRef(false);
  const suppressClickRef = useRef(false);
  // Mirrored in a ref because the drop reads it in the same gesture that set
  // it: React may not have re-rendered between the last move and the release,
  // and a reorder that depends on that timing works by luck.
  const dropIndexRef = useRef<number | null>(null);

  /** Where the held tab would land: how many others are left of the pointer. */
  const insertIndexAt = (clientX: number, held: string): number => {
    const strip = stripRef.current;
    if (!strip) return 0;
    let index = 0;
    for (const el of strip.querySelectorAll<HTMLElement>('[data-tab-id]')) {
      if (el.dataset.tabId === held) continue;
      const rect = el.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index++;
    }
    return index;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    pressRef.current = { id, x: e.clientX, el: e.currentTarget };
    draggedRef.current = false;
    // Cleared here rather than by the click it suppresses: a drag that ends
    // without one — released outside the strip, or cancelled — would otherwise
    // leave the flag set and swallow the next real click on a tab.
    suppressClickRef.current = false;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press) return;
    if (!draggedRef.current) {
      if (Math.abs(e.clientX - press.x) < DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;
      // Capture, so the gesture keeps working past the edge of the tab it
      // started on — which is the whole point of dragging one. Not every
      // pointer can be captured, and a drag that reorders is worth more than
      // one that insists on it.
      try { press.el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
      setDragId(press.id);
    }
    const index = insertIndexAt(e.clientX, press.id);
    dropIndexRef.current = index;
    setDropIndex(index);
  };

  const handlePointerUp = () => {
    const press = pressRef.current;
    pressRef.current = null;
    const index = dropIndexRef.current;
    dropIndexRef.current = null;
    if (press && draggedRef.current && index !== null) {
      saveOrder(reorder(visible.map(t => t.id), press.id, index));
      // The click that follows a drag is not a click on a tab.
      suppressClickRef.current = true;
    }
    draggedRef.current = false;
    setDragId(null);
    setDropIndex(null);
  };

  if (visible.length === 0) return null;

  const someHasNote = visible.some(s => !!notes?.[s.id]);

  // Shown in the order the drop would produce, so the strip rearranges under
  // the pointer instead of asking you to picture the result. Only `visible` is
  // ever persisted, so a gesture abandoned mid-drag leaves nothing behind.
  const byId = new Map(visible.map(t => [t.id, t]));
  const rendered = dragId !== null && dropIndex !== null
    ? reorder(visible.map(t => t.id), dragId, dropIndex).map(id => byId.get(id)!)
    : visible;

  return (
    // gap-px and a shared bottom border make this read as a strip of tabs
    // rather than a row of buttons: the active tab covers that border, which is
    // what visually joins it to the panel below.
    <div
      ref={stripRef}
      onWheel={handleStripWheel}
      className="no-scrollbar flex items-stretch gap-px overflow-x-auto border-b border-border bg-muted/20 px-2 pt-1 min-h-[34px]"
    >
      {rendered.map(s => {
        const isActive = s.id === activeId;
        const label = tabNames[s.id] || defaultLabel(s);
        const note = notes?.[s.id];
        const isDragging = dragId === s.id;


        if (editingId === s.id) {
          return (
            <div
              key={s.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded-t bg-background border border-primary border-b-0 shrink-0"
            >
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', statusDot[s.status]?.className)} />
              <input
                ref={inputRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(s.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={() => commitRename(s.id)}
                className="bg-transparent text-xs outline-none w-24"
              />
            </div>
          );
        }

        return (
          <Link
            key={s.id}
            to={`/session/${s.id}`}
            data-active={isActive}
            data-tab-id={s.id}
            // The browser's own link drag would take the gesture over.
            draggable={false}
            onPointerDown={(e) => handlePointerDown(e, s.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onClick={(e) => {
              if (suppressClickRef.current) e.preventDefault();
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              setEditingId(s.id);
              setEditValue(label);
              navigate(`/session/${s.id}`);
            }}
            title={[note, 'Double-click to rename · Drag to reorder · ⌘⇧← ⌘⇧→ to switch']
              .filter(Boolean).join('\n')}
            className={cn(
              'group relative flex flex-col justify-center px-3 py-1 rounded-t text-xs whitespace-nowrap shrink-0 transition-colors',
              // -mb-px pulls the tab down over the strip's bottom border, so the
              // active one opens into the panel the way a tab should.
              '-mb-px border border-transparent',
              // The active tab was distinguished only by a slightly different
              // background, which in a strip of sixteen is no distinction at
              // all. It now carries an accent rule along its top edge, the way
              // an editor marks the open file, and its label is the only one
              // at full weight and colour.
              isActive
                ? 'bg-background border-border border-b-background text-foreground font-medium '
                  + 'border-t-2 border-t-primary shadow-[0_-1px_6px_-2px_hsl(var(--primary)/0.35)]'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              // The held tab keeps its place in the strip and goes pale, so
              // the row you are rearranging stays legible while you do it.
              isDragging && 'opacity-40',
            )}
          >
            <div className="flex items-center gap-1.5">
              <span
                title={statusDot[s.status]?.label}
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                  statusDot[s.status]?.className,
                )}
              />
              {s.remote && <RemoteDot />}
              {/* Regular weight: a strip of bold labels reads as a row of
                  headings, and with a dozen tabs open none of them stands out.
                  The active tab is distinguished by its shape and background. */}
              <span className={cn('truncate max-w-[200px]', isActive && 'text-foreground')}>
                {label}
              </span>
              {isActive && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingId(s.id);
                    setEditValue(label);
                  }}
                  // Only on the open tab: double-click renames any of them, but
                  // a gesture with no mark on the screen is one nobody finds —
                  // and sixteen pencils would be worse than none. One, where you
                  // are already looking.
                  title="Rename this tab (or double-click it)"
                  className="ml-0.5 px-0.5 rounded leading-none text-muted-foreground/50 hover:text-foreground hover:bg-muted"
                >
                  ✎
                </button>
              )}
              <button
                onClick={(e) => handleClose(e, s.id)}
                className={cn(
                  'ml-0.5 -mr-1 px-1 rounded leading-none text-muted-foreground/40',
                  'hover:text-red-400 hover:bg-muted transition-colors',
                  // Always visible, rather than appearing on hover: a tab has a
                  // close button, and one that materialises under the cursor is
                  // a thing you discover by accident. Faint enough not to shout.
                  isActive && 'text-muted-foreground/70',
                )}
                title="Close (hide session)"
              >
                &times;
              </button>
            </div>
            {someHasNote && (
              <div className="text-[10px] italic text-muted-foreground/70 truncate max-w-[220px] leading-tight">
                {note || ' '}
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
