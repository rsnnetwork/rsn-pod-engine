import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Copy, Check, Users, Calendar, Globe, Trash2, Send, Link, Search } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

const TYPE_CONFIG: Record<string, { label: string; icon: typeof Users; variant: 'info' | 'warning' | 'default' }> = {
  pod: { label: 'Pod Invite', icon: Users, variant: 'info' },
  session: { label: 'Event Invite', icon: Calendar, variant: 'warning' },
  platform: { label: 'Platform Invite', icon: Globe, variant: 'default' },
};

export default function InvitesPage() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { addToast } = useToastStore();
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
      const payload: any = { type: inviteType, maxUses: 1, inviteeEmail };
      if (inviteType === 'pod' && podId) payload.podId = podId;
      if (inviteType === 'session' && sessionId) payload.sessionId = sessionId;
      return api.post('/invites', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      addToast(`Invite sent to ${inviteeEmail}!`, 'success');
      setInviteeEmail('');
    },
    onError: () => addToast('Failed to send invite', 'error'),
  });

  const createLinkMutation = useMutation({
    mutationFn: () => {
      const payload: any = { type: inviteType, maxUses: maxUses || 10 };
      if (inviteType === 'pod' && podId) payload.podId = podId;
      if (inviteType === 'session' && sessionId) payload.sessionId = sessionId;
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
    onError: () => addToast('Failed to create invite link', 'error'),
  });

  const bulkInviteMutation = useMutation({
    mutationFn: (emails: string[]) => {
      return Promise.all(emails.map(email => {
        const payload: any = { type: inviteType, maxUses: 1, inviteeEmail: email };
        if (inviteType === 'pod' && podId) payload.podId = podId;
        if (inviteType === 'session' && sessionId) payload.sessionId = sessionId;
        return api.post('/invites', payload);
      }));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      addToast(`${selectedUsers.length} invite(s) sent!`, 'success');
      setSelectedUsers([]);
      setUserSearch('');
    },
    onError: () => addToast('Failed to send some invites', 'error'),
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
                <select
                  value={podId}
                  onChange={e => setPodId(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
                >
                  <option value="">Select pod</option>
                  {(pods || []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            {inviteType === 'session' && (
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Event</label>
                <select
                  value={sessionId}
                  onChange={e => setSessionId(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
                >
                  <option value="">Select event</option>
                  {(sessions || []).map((s: any) => <option key={s.id} value={s.id}>{s.title || 'Untitled'}</option>)}
                </select>
              </div>
            )}
          </div>

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
                      const isSelected = selectedUsers.some(s => s.id === u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => setSelectedUsers(prev => isSelected ? prev.filter(s => s.id !== u.id) : [...prev, u])}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors ${isSelected ? 'bg-indigo-50' : ''}`}
                        >
                          <div className={`h-4 w-4 rounded border ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'} flex items-center justify-center shrink-0`}>
                            {isSelected && <Check className="h-3 w-3 text-white" />}
                          </div>
                          <span className="font-medium text-gray-800 truncate">{u.displayName || u.email}</span>
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
                  </div>
                  <p className="font-medium text-gray-800 font-mono text-sm">{inv.code}</p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    Uses: {inv.useCount || 0}{inv.maxUses ? ` / ${inv.maxUses}` : ''}
                    {inv.inviteeEmail ? ` · To: ${inv.inviteeEmail}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-1 truncate max-w-md">{getInviteUrl(inv.code)}</p>
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
