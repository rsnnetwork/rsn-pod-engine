import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import ReportUserModal from '@/components/ReportUserModal';
import {
  ArrowLeft, MapPin, Globe, Sparkles, Target, Heart,
  HelpCircle, Users, User, Award, Compass, Link2, Languages, Linkedin,
  Ban, ShieldOff, MessageSquare, Flag, Send,
} from 'lucide-react';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';

// 13 Aug 2026 (D1): Stefan — "the profile card needs a major visual upgrade,
// the greatest thing on the platform", and "About was cut off / too narrow".
// The card is now wider on desktop (max-w-3xl, was max-w-xl), opens on a brand
// band with the avatar breaking out of it, leads with About at reading size
// with no clamp and no fixed height, and lays the matching profile out in two
// columns where there is room. Every gate and affordance (message, meet,
// block, report) is unchanged in behaviour and in markup — several tests read
// this file's source to pin them.

const EMPTY = <span className="text-sm italic text-gray-300">Not shared yet</span>;

export default function PublicProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user: currentUser } = useAuthStore();
  const currentUserId = currentUser?.id;
  const { addToast } = useToastStore();
  const isOwnProfile = currentUser?.id === userId;
  const [reportOpen, setReportOpen] = useState(false);

  const { data: user, isLoading, error } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => api.get(`/users/${userId}`).then(r => r.data.data),
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId)] : [] },
  });

  // Phase B (1 May 2026 spec) — fetch the block status so the profile renders
  // either Block or Unblock. Skipped on own profile (you can't block yourself).
  const { data: blockStatus } = useQuery({
    queryKey: ['user-block-status', userId],
    queryFn: () => api.get(`/users/${userId}/block-status`).then(r => r.data.data),
    enabled: !!userId && !isOwnProfile && !!currentUser?.id,
    meta: {
      entities: currentUserId && userId
        ? [E.userBlocks(currentUserId), E.userBlocks(userId)]
        : [],
    },
  });
  const isBlocked = blockStatus?.hasBlocked === true;

  // Phase E (1 May 2026 spec) — DM gating. Message button only enabled if
  // we share an encounter with this user AND neither has blocked the other.
  const { data: dmGate } = useQuery({
    queryKey: ['can-message', userId],
    queryFn: () => api.get(`/dm/can-message/${userId}`).then(r => r.data.data),
    enabled: !!userId && !isOwnProfile && !!currentUser?.id,
    meta: {
      entities: currentUserId && userId
        ? [E.userBlocks(currentUserId), E.userBlocks(userId)]
        : [],
    },
  });
  const canMessage = dmGate?.allowed === true;
  const cantMessageReason = dmGate?.reason as string | undefined;

  // Where a meeting request between us stands. Without this the profile showed
  // a dead "Message — meet first" button to someone already asked, with no hint
  // that a request was in flight or, worse, waiting on YOU.
  const { data: meetingRequest } = useQuery({
    queryKey: ['poke-with', userId],
    queryFn: () => api.get(`/pokes/with/${userId}`).then(r => r.data.data as
      { id: string; status: 'pending' | 'accepted' | 'declined'; sentByMe: boolean } | null),
    enabled: !!userId && !isOwnProfile && !!currentUser?.id,
    meta: { entities: currentUserId ? [E.user(currentUserId)] : [] },
  });

  const interestMutation = useMutation({
    mutationFn: () => api.post(`/matches/platform/${userId}/interest`),
    onSuccess: () => {
      addToast('Meeting request sent', 'success');
      qc.invalidateQueries({ queryKey: ['poke-with', userId] });
    },
    onError: (err: any) =>
      addToast(err?.response?.data?.error?.message || 'Could not send that request', 'error'),
  });

  const blockMutation = useMutation({
    mutationFn: () => api.post(`/users/${userId}/block`),
    onSuccess: () => {
      addToast('User blocked. They can no longer message you, and you won\'t be matched together.', 'success');
      qc.invalidateQueries({ queryKey: ['user-block-status', userId] });
      qc.invalidateQueries({ queryKey: ['blocked-users'] });
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to block user', 'error');
    },
  });

  const unblockMutation = useMutation({
    mutationFn: () => api.delete(`/users/${userId}/block`),
    onSuccess: () => {
      addToast('User unblocked.', 'success');
      qc.invalidateQueries({ queryKey: ['user-block-status', userId] });
      qc.invalidateQueries({ queryKey: ['blocked-users'] });
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to unblock user', 'error');
    },
  });

  if (isLoading) return <PageLoader />;
  if (error || !user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h2 className="text-xl font-semibold text-gray-700">User not found</h2>
        <Button onClick={() => navigate(-1)} variant="secondary" className="mt-4">Go Back</Button>
      </div>
    );
  }

  const linkedinSlug = user.linkedinUrl
    ? user.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/$/, '')
    : null;
  const linkedinHref = linkedinSlug ? `https://www.linkedin.com/in/${linkedinSlug}` : null;
  const headline = [user.jobTitle, user.company].filter(Boolean).join(' at ');

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <button
        onClick={() => navigate(-1)}
        className="mb-4 inline-flex min-h-[44px] items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* ═══ PROFILE CARD ═══ */}
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm" data-testid="profile-card">

        {/* ─── Brand band + identity ─── */}
        <div className="h-24 bg-gradient-to-r from-[#1a1a2e] via-[#3a1f3d] to-rsn-red sm:h-28" aria-hidden="true" />
        <div className="px-5 pb-6 sm:px-8">
          <div className="-mt-12 flex flex-col items-center text-center sm:-mt-14 sm:flex-row sm:items-end sm:gap-5 sm:text-left">
            <div className="flex-shrink-0 rounded-full bg-white p-1 shadow-md">
              <Avatar src={user.avatarUrl} name={user.displayName || 'User'} size="2xl" />
            </div>
            <div className="mt-3 min-w-0 flex-1 sm:mt-0 sm:pb-1">
              <h1 className="break-words font-display text-2xl font-bold text-[#1a1a2e] sm:text-3xl">
                {user.displayName || 'User'}
              </h1>
              <p className="mt-1 break-words text-sm text-gray-600 sm:text-base">
                {headline || <span className="italic text-gray-300">No title</span>}
              </p>

              {/* Inline meta — always show all 3 */}
              <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-gray-500 sm:justify-start">
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> {user.location || <span className="italic text-gray-300">No location</span>}
                </span>
                <span className="flex items-center gap-1">
                  <Globe className="h-3 w-3" /> {user.industry || <span className="italic text-gray-300">No industry</span>}
                </span>
                <span className="flex items-center gap-1">
                  <Languages className="h-3 w-3" /> {user.languages?.length > 0 ? user.languages.join(', ') : <span className="italic text-gray-300">Not set</span>}
                </span>
              </div>

              {/* LinkedIn — always show */}
              <div className="mt-2">
                {linkedinHref ? (
                  <a
                    href={linkedinHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[44px] items-center gap-1 text-xs text-blue-600 hover:underline sm:min-h-0"
                  >
                    <Linkedin className="h-3.5 w-3.5" /> linkedin.com/in/{linkedinSlug}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs italic text-gray-300">
                    <Linkedin className="h-3.5 w-3.5" /> No LinkedIn
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ─── Actions ─── */}
          {!isOwnProfile && currentUser?.id && (
            <div className="mt-5 flex flex-col items-center gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:flex-wrap sm:items-start">
              {/* Phase E — Message button. Hidden when blocked. */}
              {!isBlocked && (
                <div>
                  {canMessage ? (
                    // Feature 18 (13 May spec) — one-click message. Navigates to
                    // /messages/new/:userId; MessagesPage handles the routing
                    // for both the existing-conversation and compose-new cases.
                    // No prompt; the user types their first message in the
                    // chat panel like any other message.
                    <Button
                      size="sm"
                      onClick={() => navigate(`/messages/new/${userId}`)}
                      className="min-h-[44px] text-xs"
                    >
                      <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> Message
                    </Button>
                  ) : cantMessageReason === 'not_mutual' ? (
                    // S22 (Ali, 6 Jun) — the WHY must be VISIBLE, not only a
                    // native title tooltip (which needs a long hover and never
                    // fires on touch devices). Server enforcement lives in
                    // dm.service sendMessage → canMessage(); this is display.
                    <div className="flex flex-col items-center gap-1 sm:items-start">
                      <Button size="sm" variant="ghost" disabled className="min-h-[44px] text-xs cursor-not-allowed" title="DMs unlock when you both say 'meet again'">
                        <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> Message — meet again first
                      </Button>
                      <span className="text-[11px] text-gray-400">DMs unlock when you both say “meet again”</span>
                    </div>
                  ) : cantMessageReason === 'no_encounter' ? (
                    // A dead button is the wrong answer when there IS a way through:
                    // ask to meet. And if a request already exists, say where it got
                    // to rather than pretending nothing has happened.
                    <div className="flex flex-col items-center gap-1 sm:items-start">
                      {meetingRequest?.status === 'pending' && meetingRequest.sentByMe ? (
                        <>
                          <Button size="sm" variant="ghost" disabled className="min-h-[44px] text-xs" data-testid="meet-state">
                            <Send className="mr-1.5 h-3.5 w-3.5" /> Meeting request sent
                          </Button>
                          <span className="text-[11px] text-gray-400">You can message once they accept</span>
                        </>
                      ) : meetingRequest?.status === 'pending' ? (
                        <>
                          <Button size="sm" onClick={() => navigate('/messages')} className="min-h-[44px] text-xs" data-testid="meet-state">
                            <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> They asked to meet you — respond
                          </Button>
                          <span className="text-[11px] text-gray-400">Waiting on you in Messages</span>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            onClick={() => interestMutation.mutate()}
                            isLoading={interestMutation.isPending}
                            className="min-h-[44px] text-xs"
                            data-testid="meet-state"
                          >
                            <Send className="mr-1.5 h-3.5 w-3.5" /> I want to meet
                          </Button>
                          <span className="text-[11px] text-gray-400">
                            {meetingRequest?.status === 'declined'
                              ? 'A previous request was declined'
                              : 'Messaging unlocks once they accept'}
                          </span>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              )}

              {/* Phase B — Block / Unblock button. */}
              <div>
                {isBlocked ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => unblockMutation.mutate()}
                    isLoading={unblockMutation.isPending}
                    className="min-h-[44px] text-xs"
                  >
                    <ShieldOff className="h-3.5 w-3.5 mr-1.5" /> Unblock
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Block ${user.displayName || 'this user'}? They won't be able to message you and you won't be matched together in future events.`)) {
                        blockMutation.mutate();
                      }
                    }}
                    isLoading={blockMutation.isPending}
                    className="min-h-[44px] text-xs text-red-500 hover:bg-red-50"
                  >
                    <Ban className="h-3.5 w-3.5 mr-1.5" /> Block
                  </Button>
                )}
              </div>

              {/* Task E4 — report entry point. Self-reports are blocked
                  client-side (and rejected server-side as a backstop). */}
              <button
                onClick={() => setReportOpen(true)}
                className="inline-flex min-h-[44px] items-center gap-1.5 px-3 text-xs text-gray-400 transition-colors hover:text-red-500"
              >
                <Flag className="h-3.5 w-3.5" /> Report this member
              </button>
            </div>
          )}
        </div>

        {/* ─── About — the lead section, at reading size, never clipped ─── */}
        <Section icon={User} title="About" lead>
          {user.bio
            ? (
              <p
                data-testid="profile-about"
                className="whitespace-pre-line break-words text-base leading-relaxed text-gray-800"
              >
                {user.bio}
              </p>
            )
            : <span data-testid="profile-about" className="text-sm italic text-gray-300">Not shared yet</span>}
        </Section>

        <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-gray-100">
          {/* ─── Interests ─── */}
          <Section icon={Sparkles} title="Interests">
            {user.interests?.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {user.interests.map((t: string) => (
                  <span key={t} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">{t}</span>
                ))}
              </div>
            ) : EMPTY}
          </Section>

          {/* ─── Reasons to Connect ─── */}
          <Section icon={Link2} title="Reasons to Connect">
            {user.reasonsToConnect?.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {user.reasonsToConnect.map((r: string) => (
                  <span key={r} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">{r}</span>
                ))}
              </div>
            ) : EMPTY}
          </Section>
        </div>

        {/* ─── Expertise ─── */}
        <Section icon={Award} title="Expertise">
          {user.expertiseText
            ? <p className="whitespace-pre-line break-words text-sm leading-relaxed text-gray-700">{user.expertiseText}</p>
            : EMPTY}
        </Section>

        {/* ─── Matching Profile — always show all 5 ─── */}
        <div className="border-t border-gray-100 px-5 py-5 sm:px-8">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-400">Matching Profile</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-8">
            <MatchField icon={Heart} label="What I Care About" value={user.whatICareAbout} />
            <MatchField icon={HelpCircle} label="What I Can Help With" value={user.whatICanHelpWith} />
            <MatchField icon={Users} label="Who I Want to Meet" value={user.whoIWantToMeet} />
            <MatchField icon={Target} label="Why I Want to Meet" value={user.whyIWantToMeet} />
            <MatchField icon={Compass} label="My Intent" value={user.myIntent} />
          </div>
        </div>
      </div>

      {!isOwnProfile && (
        <ReportUserModal
          open={reportOpen}
          onClose={() => setReportOpen(false)}
          reportedId={userId!}
          reportedDisplayName={user.displayName}
        />
      )}
    </div>
  );
}

function Section({ icon: Icon, title, lead, children }: {
  icon: React.ComponentType<{ className?: string }>; title: string; lead?: boolean; children: React.ReactNode;
}) {
  return (
    <div className={`border-t border-gray-100 px-5 sm:px-8 ${lead ? 'py-6' : 'py-4'}`}>
      <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
        <Icon className="h-3.5 w-3.5 text-rsn-red/70" /> {title}
      </h3>
      {children}
    </div>
  );
}

function MatchField({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value?: string | null }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-gray-100 bg-gray-50">
        <Icon className="h-3.5 w-3.5 text-gray-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wider text-gray-400">{label}</p>
        {value
          ? <p className="mt-0.5 break-words text-sm leading-relaxed text-gray-700">{value}</p>
          : <p className="mt-0.5 text-sm italic text-gray-300">Not shared yet</p>}
      </div>
    </div>
  );
}
