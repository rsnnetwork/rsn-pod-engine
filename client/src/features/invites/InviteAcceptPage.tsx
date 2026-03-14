import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { Users, Calendar, LogIn, UserPlus } from 'lucide-react';
import api from '@/lib/api';

export default function InviteAcceptPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const [invite, setInvite] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoAcceptedRef = useRef(false);

  useEffect(() => {
    api.get(`/invites/${code}`).then(r => setInvite(r.data.data)).catch(() => setInvite(null)).finally(() => setLoading(false));
  }, [code]);

  // Determine the final destination after accepting the invite
  const getDestination = useCallback((data: any) => {
    const sessionId = data?.sessionId || invite?.sessionId;
    const podId = data?.podId || invite?.podId;
    if (sessionId) return `/sessions/${sessionId}`;
    if (podId) return `/pods/${podId}`;
    return '/sessions';
  }, [invite]);

  const accept = useCallback(async () => {
    setAccepting(true);
    setError(null);
    try {
      const res = await api.post(`/invites/${code}/accept`);
      addToast('Invite accepted!', 'success');
      const data = res.data?.data;
      const destination = getDestination(data);

      // Check if profile is incomplete — redirect to onboarding first
      const isProfileIncomplete = !user?.displayName || !user?.jobTitle || !user?.reasonsToConnect?.length;
      if (isProfileIncomplete) {
        navigate(`/onboarding?redirect=${encodeURIComponent(destination)}`, { replace: true });
      } else {
        navigate(destination, { replace: true });
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || 'Failed to accept invite';
      setError(msg);
      addToast(msg, 'error');
    } finally {
      setAccepting(false);
    }
  }, [code, invite, user, navigate, addToast, getDestination]);

  // Auto-accept for logged-in users — seamless deep linking
  useEffect(() => {
    if (user && invite && !autoAcceptedRef.current && !accepting) {
      autoAcceptedRef.current = true;
      accept();
    }
  }, [user, invite, accepting, accept]);

  // Show loader while auto-accepting or fetching invite
  if (loading || (user && invite && !error)) return <PageLoader />;

  const InviteIcon = invite?.type === 'session' ? Calendar : Users;
  const inviteLabel = invite?.type === 'pod' ? 'a pod' : invite?.type === 'session' ? 'an event' : 'RSN';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-white to-gray-50/50 p-4">
      <Card className="max-w-md w-full text-center">
        {invite ? (
          <>
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-indigo-50 text-indigo-500 mx-auto mb-4">
              <InviteIcon className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">You&apos;re invited!</h2>
            <p className="text-gray-500 mb-6">
              You&apos;ve been invited to join {inviteLabel}. Sign in or create an account to get started.
            </p>
            {error && (
              <p className="text-red-500 text-sm mb-4">{error}</p>
            )}
            {user ? (
              <Button onClick={accept} isLoading={accepting} className="w-full">
                {error ? 'Try Again' : 'Accept Invite'}
              </Button>
            ) : (
              <div className="space-y-3">
                <Button onClick={() => navigate(`/login?redirect=/invite/${code}&inviteCode=${code}`)} className="w-full">
                  <LogIn className="h-4 w-4 mr-2" /> Sign In
                </Button>
                <Button variant="secondary" onClick={() => navigate(`/login?redirect=/invite/${code}&inviteCode=${code}`)} className="w-full">
                  <UserPlus className="h-4 w-4 mr-2" /> Create Account
                </Button>
                <p className="text-xs text-gray-400 mt-2">
                  After signing in, you&apos;ll be taken directly to {inviteLabel}.
                </p>
              </div>
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
