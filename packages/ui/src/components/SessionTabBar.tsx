import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Session } from '../lib/api';
import { visibleTabs, loadClosedTabs, saveClosedTabs } from '../lib/tabs';
import { RemoteDot } from './SourceBadge';
import { cn, truncate } from '../lib/utils';

const statusColors: Record<string, string> = {
  running: 'bg-green-500',
  idle: 'bg-yellow-500',
  stopped: 'bg-gray-500',
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
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => loadClosedTabs());
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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

  // --- Drag handlers ---
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Make the drag image semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
    }
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragId) {
      setDropTarget(id);
    }
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    const ids = visible.map(s => s.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragId);
    saveOrder(ids);
    setDragId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };

  if (visible.length === 0) return null;

  const someHasNote = visible.some(s => !!notes?.[s.id]);

  return (
    // gap-px and a shared bottom border make this read as a strip of tabs
    // rather than a row of buttons: the active tab covers that border, which is
    // what visually joins it to the panel below.
    <div className="flex items-stretch gap-px overflow-x-auto border-b border-border bg-muted/20 px-2 pt-1 min-h-[34px]">
      {visible.map(s => {
        const isActive = s.id === activeId;
        const label = tabNames[s.id] || defaultLabel(s);
        const note = notes?.[s.id];
        const isDragging = dragId === s.id;
        const isDropTarget = dropTarget === s.id && dragId !== s.id;

        if (editingId === s.id) {
          return (
            <div
              key={s.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded-t bg-background border border-primary border-b-0 shrink-0"
            >
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', statusColors[s.status])} />
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
            draggable
            onDragStart={(e) => handleDragStart(e, s.id)}
            onDragOver={(e) => handleDragOver(e, s.id)}
            onDrop={(e) => handleDrop(e, s.id)}
            onDragEnd={handleDragEnd}
            onDoubleClick={(e) => {
              e.preventDefault();
              setEditingId(s.id);
              setEditValue(label);
              navigate(`/session/${s.id}`);
            }}
            title={note ? `${note}\nDouble-click to rename · Drag to reorder` : 'Double-click to rename · Drag to reorder'}
            className={cn(
              'group relative flex flex-col justify-center px-3 py-1 rounded-t text-xs whitespace-nowrap shrink-0 transition-colors',
              // -mb-px pulls the tab down over the strip's bottom border, so the
              // active one opens into the panel the way a tab should.
              '-mb-px border border-transparent',
              isActive
                ? 'bg-background border-border border-b-background text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              isDragging && 'opacity-40',
              isDropTarget && 'ring-1 ring-primary',
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', statusColors[s.status])} />
              {s.remote && <RemoteDot />}
              {/* Regular weight: a strip of bold labels reads as a row of
                  headings, and with a dozen tabs open none of them stands out.
                  The active tab is distinguished by its shape and background. */}
              <span className={cn('truncate max-w-[200px]', isActive && 'text-foreground')}>
                {label}
              </span>
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
