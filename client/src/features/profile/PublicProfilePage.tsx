import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import {
  ArrowLeft, MapPin, Globe, Sparkles, Target, Heart,
  HelpCircle, Users, User, Award, Compass, Link2, Languages, Linkedin,
} from 'lucide-react';
import api from '@/lib/api';

const EMPTY = <span className="text-sm italic text-gray-300">Not shared yet</span>;

export default function PublicProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();

  const { data: user, isLoading, error } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => api.get(`/users/${userId}`).then(r => r.data.data),
    enabled: !!userId,
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

  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-5">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* ═══ PROFILE CARD ═══ */}
      <div className="rounded-xl bg-white shadow-sm border border-gray-200">

        {/* ─── Avatar + Identity ─── */}
        <div className="px-6 pt-8 pb-5 text-center">
          <div className="inline-block rounded-full p-[3px] border-2 border-rsn-red/30">
            <Avatar src={user.avatarUrl} name={user.displayName || 'User'} size="xl" />
          </div>
          <h1 className="mt-3 text-xl font-bold text-gray-900">{user.displayName || 'User'}</h1>

          <p className="mt-1 text-sm text-gray-500">
            {(user.jobTitle || user.company)
              ? [user.jobTitle, user.company].filter(Boolean).join(' at ')
              : <span className="italic text-gray-300">No title</span>}
          </p>

          {/* Inline meta — always show all 3 */}
          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-gray-400">
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
          <div className="mt-2.5">
            {linkedinHref ? (
              <a
                href={linkedinHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
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

        {/* ─── About ─── */}
        <Section icon={User} title="About">
          {user.bio
            ? <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.bio}</p>
            : EMPTY}
        </Section>

        {/* ─── Interests ─── */}
        <Section icon={Sparkles} title="Interests">
          {user.interests?.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {user.interests.map((t: string) => (
                <span key={t} className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-full">{t}</span>
              ))}
            </div>
          ) : EMPTY}
        </Section>

        {/* ─── Expertise ─── */}
        <Section icon={Award} title="Expertise">
          {user.expertiseText
            ? <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.expertiseText}</p>
            : EMPTY}
        </Section>

        {/* ─── Reasons to Connect ─── */}
        <Section icon={Link2} title="Reasons to Connect">
          {user.reasonsToConnect?.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {user.reasonsToConnect.map((r: string) => (
                <span key={r} className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-full">{r}</span>
              ))}
            </div>
          ) : EMPTY}
        </Section>

        {/* ─── Matching Profile — always show all 5 ─── */}
        <div className="border-t border-gray-100 px-6 py-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Matching Profile</h3>
          <div className="space-y-4">
            <MatchField icon={Heart} label="What I Care About" value={user.whatICareAbout} />
            <MatchField icon={HelpCircle} label="What I Can Help With" value={user.whatICanHelpWith} />
            <MatchField icon={Users} label="Who I Want to Meet" value={user.whoIWantToMeet} />
            <MatchField icon={Target} label="Why I Want to Meet" value={user.whyIWantToMeet} />
            <MatchField icon={Compass} label="My Intent" value={user.myIntent} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-100 px-6 py-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-rsn-red/70" /> {title}
      </h3>
      {children}
    </div>
  );
}

function MatchField({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value?: string | null }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-md bg-gray-50 border border-gray-100 flex items-center justify-center">
        <Icon className="h-3.5 w-3.5 text-gray-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</p>
        {value
          ? <p className="mt-0.5 text-sm text-gray-700 leading-relaxed">{value}</p>
          : <p className="mt-0.5 text-sm italic text-gray-300">Not shared yet</p>}
      </div>
    </div>
  );
}
