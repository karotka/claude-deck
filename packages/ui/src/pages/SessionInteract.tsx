import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchSession, type Session } from '../lib/api';
import { TerminalCapture } from '../components/TerminalCapture';
import { projectName } from '../lib/utils';
import { isInteractive } from '../lib/tabs';

export function SessionInteract() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetchSession(id).then(setSession).finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading session...</div>;
  }

  if (!session) {
    return <div className="p-6 text-muted-foreground">Session not found.</div>;
  }

  const canInteract = isInteractive(session);
  const where = session.target ? session.target.label ?? session.target.ref : null;

  return (
    <div className="max-w-5xl mx-auto p-6 h-[calc(100vh-48px)] flex flex-col">
      <div className="flex items-center gap-4 mb-4">
        <Link to={`/session/${session.id}`} className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Session Detail
        </Link>
        <h1 className="text-lg font-bold">
          Interact: {projectName(session.projectPath)}
          {where && <span className="text-sm font-normal text-muted-foreground ml-2">({where})</span>}
        </h1>
      </div>

      <div className="flex-1 rounded-lg border border-border overflow-hidden">
        {id && <TerminalCapture sessionId={id} canInteract={canInteract} />}
      </div>
    </div>
  );
}
