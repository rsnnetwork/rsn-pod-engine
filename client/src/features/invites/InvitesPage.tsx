import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Copy, Check, Users, Calendar, Globe, Trash2, Send, Link, Search, Inbox, UserCheck, X } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { isAdmin } from '@/lib/utils';
import api from '@/lib/api';

const TYPE_CONFIG: Record<string, { label: string; icon: typeof Users; variant: 'info' | 'warning' | 'default' }> = {
  pod: { label: 'Pod Invite', icon: Users, variant: 'info' },
  session: { label: 'Event Invite', icon: Calendar, variant: 'warning' },
  platform: { label: 'Platform Invite', icon: Globe, variant: 'default' },
};

export default function InvitesPage() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const userIsAdmin = isAdmin(user?.role);
  const qc = useQueryClient();

  // Inline create form state
  const [inviteType, setInviteType] = useState('pod');
  const [podId, setPodId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [inviteeEmail, setInviteeEmail] = useState('');
  const [maxUses, setMaxUses] = useState(10);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<any[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['my-invites'],
    queryFn: () => api.get('/invites').then(r => r.data.data ?? []),
  });

  const { data: pods } = useQuery({
    queryKey: ['my-pods'],
    queryFn: () => api.get('/pods').then(r => r.data.data ?? []),
  });

  const { data: sessions } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get('/sessions').then(r => r.data.data ?? []),
  });

  const { data: searchResults } = useQuery({
    queryKey: ['user-search', userSearch],
    queryFn: () => api.get(`/users/search?q=${encodeURIComponent(userSearch)}`).then(r => r.data.data ?? []),
    enabled: userSearch.length >= 1,
  });

  // Fetch members/participants for selected pod/session to tag search results
  const { data: podMembers } = useQuery({
    queryKey: ['pod-members', podId],
    queryFn: () => api.get(`/pods/${podId}/members`).then(r => r.data.data ?? []),
    enabled: inviteType === 'pod' && !!podId,
  });

  const { data: sessionParticipants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: inviteType === 'session' && !!sessionId,
  });

  // Invites sent TO this user (pod/event invites from directors/hosts/admins)
  const { data: receivedInvites } = useQuery({
    queryKey: ['received-invites'],
    queryFn: () => api.get('/invites/received').then(r => r.data.data ?? []),
  });

  const acceptInviteMutation = useMutation({
    mutationFn: (code: string) => api.post(`/invites/${code}/accept`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['received-invites'] });
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      qc.invalidateQueries({ queryKey: ['my-sessions'] });
      addToast('Invite accepted!', 'success');
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Failed to accept invite', 'error'),
  });

  const declineInviteMutation = useMutation({
    mutationFn: (code: string) => api.post(`/invites/${code}/decline`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['received-invites'] });
      addToast('Invite declined', 'info');
    },
    onError: () => addToast('Failed to decline invite', 'error'),
  });

  const getInviteUrl = (code: string) => `${window.location.origin}/invite/${code}`;

  const copyLink = async (inv: any) => {
    try {
      await navigator.clipboard.writeText(getInviteUrl(inv.code));
      setCopiedId(inv.id);
      addToast('Invite link copied!', 'success');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      addToast('Failed to copy', 'error');
    }
  };

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/invites/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      addToast('Invite revoked', 'success');
    },
    onError: () => addToast('Failed to revoke invite', 'error'),
  });

  const sendEmailMutation = useMutation({
    mutationFn: () => {
      if (needsTarget) { throw new Error('Please select a pod or event first'); }
      const payload: any = { type: inviteType, maxUses: 1, inviteeEmail };
      if (inviteType === 'pod') payload.podId = podId;
      if (inviteType === 'session') payload.sessionId = sessionId;
      return api.post('/invites', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      addToast(`Invite sent to ${inviteeEmail}!`, 'success');
      setInviteeEmail('');
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Failed to send invite', 'error'),
  });

  const createLinkMutation = useMutation({
    mutationFn: () => {
      if (needsTarget) { throw new Error('Please select a pod or event first'); }
      const payload: any = { type: inviteType, maxUses: maxUses || 10 };
      if (inviteType === 'pod') payload.podId = podId;
      if (inviteType === 'session') payload.sessionId = sessionId;
      return api.post('/invites', payload);
    },
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      const code = res.data.data?.code;
      const link = `${window.location.origin}/invite/${code}`;
      setGeneratedLink(link);
      try {
        await navigator.clipboard.writeText(link);
        addToast('Invite link created and copied!', 'success');
      } catch {
        addToast('Invite link created — copy it below', 'success');
      }
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || err?.message || 'Failed to create invite link', 'error'),
  });

  const bulkInviteMutation = useMutation({
    mutationFn: async (emails: string[]) => {
      if (needsTarget) { throw new Error('Please select a pod or event first'); }
      const results = [];
      for (const email of emails) {
        const payload: any = { type: inviteType, maxUses: 1, inviteeEmail: email };
        if (inviteType === 'pod') payload.podId = podId;
        if (inviteType === 'session') payload.sessionId = sessionId;
        try {
          await api.post('/invites', payload);
          results.push({ email, ok: true });
        } catch (err: any) {
          const msg = err?.response?.data?.error?.message || 'Failed';
          results.push({ email, ok: false, msg });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      const failed = results.filter(r => !r.ok);
      const succeeded = results.filter(r => r.ok);
      if (succeeded.length > 0) addToast(`${succeeded.length} invite(s) sent!`, 'success');
      failed.forEach(r => addToast(`${r.email}: ${r.msg}`, 'error'));
      setSelectedUsers([]);
      setUserSearch('');
    },
    onError: (err: any) => addToast(err?.message || 'Failed to send invites', 'error'),
  });

  // Filter pods to only those where user is director/host (admins see all)
  const invitablePods = (pods || []).filter((p: any) =>
    userIsAdmin || p.memberRole === 'director' || p.memberRole === 'host'
  );

  // Filter sessions to only those user hosts + active/scheduled only (admins see all non-completed)
  const invitableSessions = (sessions || []).filter((s: any) => {
    const isActiveSession = s.status === 'scheduled' || s.status === 'active' || s.status === 'lobby';
    if (!isActiveSession) return false;
    return userIsAdmin || s.hostUserId === user?.id;
  });

  const needsTarget = (inviteType === 'pod' && !podId) || (inviteType === 'session' && !sessionId);

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Invites</h1>
      </div>

      {/* Inline Create Invite Form */}
      <Card className="animate-fade-in-up">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-4">Create Invite</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Invite Type</label>
              <select
                value={inviteType}
                onChange={e => { setInviteType(e.target.value); setPodId(''); setSessionId(''); }}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
              >
                <option value="pod">Pod Invite</option>
                <option value="session">Event Invite</option>
                <option value="platform">Platform Invite</option>
              </select>
            </div>
            {inviteType === 'pod' && (
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Pod</label>
                {invitablePods.length === 0 ? (
                  <p className="text-sm text-gray-400 bg-gray-50 rounded-xl px-4 py-2.5 border border-gray-200">
                    No pods available. You must be a director or host of a pod to send invites.
                  </p>
                ) : (
                  <select
                    value={podId}
                    onChange={e => setPodId(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
                  >
                    <option value="">Select pod</option>
                    {invitablePods.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
              </div>
            )}
            {inviteType === 'session' && (
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Event</label>
                {invitableSessions.length === 0 ? (
                  <p className="text-sm text-gray-400 bg-gray-50 rounded-xl px-4 py-2.5 border border-gray-200">
                    No events available. You can only invite to active events you host.
                  </p>
                ) : (
                  <select
                    value={sessionId}
                    onChange={e => setSessionId(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
                  >
                    <option value="">Select event</option>
                    {invitableSessions.map((s: any) => <option key={s.id} value={s.id}>{s.title || 'Untitled'}</option>)}
                  </select>
                )}
              </div>
            )}
          </div>

          {needsTarget && (
            <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Please select a {inviteType === 'pod' ? 'pod' : 'event'} above before sending invites.
            </p>
          )}

          {/* Invite options */}
          <div className={`grid grid-cols-1 ${inviteType === 'platform' ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-4`}>
            {/* Option 1: Send to email */}
            <div className="rounded-xl border border-gray-200 p-4 space-y-3">
              <p className="text-sm font-medium text-gray-700 flex items-center gap-2"><Send className="h-4 w-4 text-indigo-500" /> Send to email</p>
              <p className="text-xs text-gray-400">A unique, single-use invite emailed directly.</p>
              <Input type="email" value={inviteeEmail} onChange={e => setInviteeEmail(e.target.value)} placeholder="someone@example.com" />
              <Button
                size="sm"
                onClick={() => sendEmailMutation.mutate()}
                isLoading={sendEmailMutation.isPending}
                disabled={!inviteeEmail || needsTarget}
                className="w-full"
              >
                <Send className="h-4 w-4 mr-1" /> Send Invite Email
              </Button>
            </div>

            {/* Option 2: Invite platform users (not for platform invites — those are for non-users) */}
            {inviteType !== 'platform' && (
              <div className="rounded-xl border border-gray-200 p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700 flex items-center gap-2"><Users className="h-4 w-4 text-amber-500" /> Invite platform users</p>
                <p className="text-xs text-gray-400">Search existing users and invite them directly.</p>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    value={userSearch}
                    onChange={e => setUserSearch(e.target.value)}
                    placeholder="Search by name or email..."
                    className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
                  />
                </div>
                {userSearch.length >= 1 && searchResults && searchResults.length === 0 && (
                  <p className="text-xs text-gray-400 text-center py-2">No users found matching "{userSearch}"</p>
                )}
                {searchResults && searchResults.length > 0 && (
                  <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                    {searchResults.map((u: any) => {
                      const isExisting = inviteType === 'pod'
                        ? (podMembers || []).some((m: any) => m.userId === u.id && m.status === 'active')
                        : inviteType === 'session'
                        ? (sessionParticipants || []).some((p: any) => p.userId === u.id)
                        : false;
                      const isSelected = !isExisting && selectedUsers.some(s => s.id === u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          disabled={isExisting}
                          onClick={() => !isExisting && setSelectedUsers(prev => isSelected ? prev.filter(s => s.id !== u.id) : [...prev, u])}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${isExisting ? 'opacity-60 cursor-not-allowed bg-gray-50' : isSelected ? 'bg-indigo-50 hover:bg-indigo-100' : 'hover:bg-gray-50'}`}
                        >
                          {!isExisting && (
                            <div className={`h-4 w-4 rounded border ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'} flex items-center justify-center shrink-0`}>
                              {isSelected && <Check className="h-3 w-3 text-white" />}
                            </div>
                          )}
                          <span className={`font-medium truncate ${isExisting ? 'text-gray-400' : 'text-gray-800'}`}>{u.displayName || u.email}</span>
                          {isExisting && (
                            <span className="ml-auto text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">
                              {inviteType === 'pod' ? 'Already a member' : 'Already registered'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedUsers.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-500">{selectedUsers.length} user(s) selected</p>
                    <Button
                      size="sm"
                      onClick={() => bulkInviteMutation.mutate(selectedUsers.map(u => u.email))}
                      isLoading={bulkInviteMutation.isPending}
                      disabled={needsTarget}
                      className="w-full"
                    >
                      <Mail className="h-4 w-4 mr-1" /> Send {selectedUsers.length} Invite(s)
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Option 3: Create shareable link */}
            <div className="rounded-xl border border-gray-200 p-4 space-y-3">
              <p className="text-sm font-medium text-gray-700 flex items-center gap-2"><Link className="h-4 w-4 text-emerald-500" /> Shareable link</p>
              <p className="text-xs text-gray-400">A multi-use link you can share manually.</p>
              <Input label="Max Uses" type="number" value={maxUses} onChange={e => setMaxUses(Number(e.target.value))} placeholder="10" />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => createLinkMutation.mutate()}
                isLoading={createLinkMutation.isPending}
                disabled={needsTarget}
                className="w-full"
              >
                <Copy className="h-4 w-4 mr-1" /> Create & Copy Link
              </Button>
              {generatedLink && (
                <div className="flex items-center gap-2">
                  <input readOnly value={generatedLink} className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 truncate" />
                  <button type="button" onClick={() => { navigator.clipboard.writeText(generatedLink); addToast('Copied!', 'success'); }} className="text-indigo-600 hover:text-indigo-800 p-1">
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Received Invites */}
      {receivedInvites && receivedInvites.length > 0 && (
        <div className="animate-fade-in-up">
          <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
            <Inbox className="h-5 w-5 text-indigo-600" /> Pending Invites for You ({receivedInvites.length})
          </h2>
          <div className="grid gap-3">
            {receivedInvites.map((inv: any) => {
              const typeConf = TYPE_CONFIG[inv.type] || TYPE_CONFIG.platform;
              const TypeIcon = typeConf.icon;
              const targetName = inv.podName || inv.sessionTitle || 'RSN Platform';
              return (
                <Card key={inv.id} className="border-indigo-200 bg-indigo-50/30">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={typeConf.variant} className="text-xs flex items-center gap-1">
                          <TypeIcon className="h-3 w-3" /> {typeConf.label}
                        </Badge>
                        <span className="text-sm font-semibold text-[#1a1a2e]">{targetName}</span>
                      </div>
                      <p className="text-sm text-gray-500">
                        From <span className="font-medium text-gray-700">{inv.inviterName || 'Someone'}</span>
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Sent {new Date(inv.createdAt).toLocaleDateString()}
                        {inv.expiresAt && ` · Expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => acceptInviteMutation.mutate(inv.code)}
                        isLoading={acceptInviteMutation.isPending}
                      >
                        <UserCheck className="h-4 w-4 mr-1" /> Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => declineInviteMutation.mutate(inv.code)}
                        isLoading={declineInviteMutation.isPending}
                        className="text-gray-400 hover:text-red-500"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Invite List */}
      {(!data || data.length === 0) ? (
        <EmptyState
          icon={<Mail className="h-8 w-8" />}
          title="No invites yet"
          description="Create invite links above to grow your pods."
        />
      ) : (
        <div className="grid gap-4 animate-fade-in-up">
          {data.map((inv: any) => {
            const typeConf = TYPE_CONFIG[inv.type] || TYPE_CONFIG.platform;
            const TypeIcon = typeConf.icon;
            const isActive = inv.status === 'active' || inv.status === 'pending';
            return (
            <Card key={inv.id}>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={typeConf.variant} className="text-xs flex items-center gap-1">
                      <TypeIcon className="h-3 w-3" /> {typeConf.label}
                    </Badge>
                    {inv.podName && <span className="text-sm font-medium text-gray-700">{inv.podName}</span>}
                    {inv.sessionTitle && <span className="text-sm font-medium text-gray-700">{inv.sessionTitle}</span>}
                  </div>
                  <p className="text-sm text-gray-500 mt-0.5">
                    Uses: {inv.useCount || 0}{inv.maxUses ? ` / ${inv.maxUses}` : ''}
                    {inv.inviteeEmail ? ` · To: ${inv.inviteeEmail}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Created {new Date(inv.createdAt).toLocaleDateString()}
                    {inv.acceptedAt && ` · Accepted ${new Date(inv.acceptedAt).toLocaleDateString()}`}
                    {inv.expiresAt && inv.status === 'pending' && ` · Expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={isActive ? 'success' : 'default'}>{inv.status}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyLink(inv)}
                    title="Copy invite link"
                  >
                    {copiedId === inv.id ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  {isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { if (confirm('Revoke this invite? It will no longer be usable.')) revokeMutation.mutate(inv.id); }}
                      title="Revoke invite"
                      className="text-red-400 hover:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );})}
        </div>
      )}
    </div>
  );
}
