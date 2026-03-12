import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

export default function InviteAcceptPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const [invite, setInvite] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    api.get(`/invites/${code}`).then(r => setInvite(r.data.data)).catch(() => setInvite(null)).finally(() => setLoading(false));
  }, [code]);

  const accept = async () => {
    setAccepting(true);
    try {
      const res = await api.post(`/invites/${code}/accept`);
      addToast('Invite accepted!', 'success');
      // Deep link: redirect to the session/event if it's a session invite, otherwise to the pod
      const data = res.data?.data;
      if (data?.sessionId) {
        navigate(`/sessions/${data.sessionId}`);
      } else if (data?.podId) {
        navigate(`/pods/${data.podId}`);
      } else if (invite?.sessionId) {
        navigate(`/sessions/${invite.sessionId}`);
      } else if (invite?.podId) {
        navigate(`/pods/${invite.podId}`);
      } else {
        navigate('/sessions');
      }
    } catch {
      addToast('Failed to accept invite', 'error');
    } finally {
      setAccepting(false);
    }
  };

  if (loading) return <PageLoader />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-4">
      <Card className="max-w-md w-full text-center">
        {invite ? (
          <>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">You&apos;re invited!</h2>
            <p className="text-gray-500 mb-6">
              {invite.type === 'pod' ? "You've been invited to join a pod" :
               invite.type === 'session' ? "You've been invited to an event" :
               "You've been invited to join RSN"}
            </p>
            {user ? (
              <Button onClick={accept} isLoading={accepting} className="w-full">Accept Invite</Button>
            ) : (
              <Button onClick={() => navigate(`/login?redirect=/invite/${code}`)} className="w-full">Sign in to accept</Button>
            )}
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Invalid Invite</h2>
            <p className="text-gray-500 mb-4">This invite link is invalid or expired.</p>
            <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
          </>
        )}
      </Card>
    </div>
  );
}
