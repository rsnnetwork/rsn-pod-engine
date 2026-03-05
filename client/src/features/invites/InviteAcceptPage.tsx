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
      await api.post(`/invites/${code}/accept`);
      addToast('Invite accepted!', 'success');
      navigate('/pods');
    } catch {
      addToast('Failed to accept invite', 'error');
    } finally {
      setAccepting(false);
    }
  };

  if (loading) return <PageLoader />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950 p-4">
      <Card className="max-w-md w-full text-center">
        {invite ? (
          <>
            <h2 className="text-xl font-bold text-surface-100 mb-2">You&apos;re invited!</h2>
            <p className="text-surface-400 mb-6">You&apos;ve been invited to join a pod</p>
            {user ? (
              <Button onClick={accept} isLoading={accepting} className="w-full">Accept Invite</Button>
            ) : (
              <Button onClick={() => navigate(`/login?redirect=/invite/${code}`)} className="w-full">Sign in to accept</Button>
            )}
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold text-surface-100 mb-2">Invalid Invite</h2>
            <p className="text-surface-400 mb-4">This invite link is invalid or expired.</p>
            <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
          </>
        )}
      </Card>
    </div>
  );
}
