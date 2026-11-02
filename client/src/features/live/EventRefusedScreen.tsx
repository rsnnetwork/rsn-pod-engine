// The final screen for someone an event is closed to (P1 item 9; shared by the live page since the final fix wave C4,
// 2 Nov 2026). "This event is not open to you.", the server's reason when it gives one, and, for an event whose places
// the host approves, the way to the event page where the request is made. Never a "Reconnecting" screen: it is final.
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { REFUSED_SENTENCE } from './session-guard-state';

export default function EventRefusedScreen({ sessionId, detail, requestOnEventPage }: {
  sessionId: string | undefined; detail: string; requestOnEventPage: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-white px-6" data-testid="event-refused">
      <div className="text-center max-w-md">
        <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{REFUSED_SENTENCE}</h2>
        <p className="text-sm text-gray-500 mb-6">{detail}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {requestOnEventPage && sessionId && (
            <Button onClick={() => navigate(`/sessions/${sessionId}`)}>Open the event page</Button>
          )}
          <Button variant={requestOnEventPage ? 'secondary' : 'primary'} onClick={() => navigate('/sessions')}>Back to events</Button>
        </div>
      </div>
    </div>
  );
}
