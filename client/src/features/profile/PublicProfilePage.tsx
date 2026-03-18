import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import {
  ArrowLeft, Briefcase, MapPin, Globe, Sparkles, Target, Heart,
  HelpCircle, Users, User, Award, Compass, Link2, Languages, Linkedin,
} from 'lucide-react';
import api from '@/lib/api';

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

  // Collect matching profile sections that have data
  const matchingSections = [
    { key: 'whatICareAbout', label: 'What I Care About', Icon: Heart, color: 'text-rose-500' },
    { key: 'whatICanHelpWith', label: 'What I Can Help With', Icon: HelpCircle, color: 'text-emerald-500' },
    { key: 'whoIWantToMeet', label: 'Who I Want to Meet', Icon: Users, color: 'text-blue-500' },
    { key: 'whyIWantToMeet', label: 'Why I Want to Meet', Icon: Target, color: 'text-amber-500' },
    { key: 'myIntent', label: 'My Intent', Icon: Compass, color: 'text-indigo-500' },
  ].filter(s => user[s.key]);

  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* ═══════════════════ HERO CARD ═══════════════════ */}
      <div className="rounded-2xl overflow-hidden shadow-lg border border-gray-100 bg-white">

        {/* ─── Top gradient banner + avatar ─── */}
        <div className="relative h-28 bg-gradient-to-br from-rsn-red via-rsn-red/80 to-rose-400">
          <div className="absolute -bottom-12 left-1/2 -translate-x-1/2">
            <div className="rounded-full p-1 bg-white shadow-lg">
              <Avatar src={user.avatarUrl} name={user.displayName || 'User'} size="xl" />
            </div>
          </div>
        </div>

        {/* ─── Name + title block ─── */}
        <div className="pt-14 pb-5 px-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">{user.displayName}</h1>

          {(user.jobTitle || user.company) && (
            <p className="mt-1.5 text-gray-500 flex items-center justify-center gap-1.5 text-sm font-medium">
              <Briefcase className="h-3.5 w-3.5 text-gray-400" />
              {[user.jobTitle, user.company].filter(Boolean).join(' at ')}
            </p>
          )}

          {/* Quick info row */}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-gray-400">
            {user.location && (
              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {user.location}</span>
            )}
            {user.industry && (
              <span className="flex items-center gap-1"><Globe className="h-3 w-3" /> {user.industry}</span>
            )}
            {user.languages?.length > 0 && (
              <span className="flex items-center gap-1"><Languages className="h-3 w-3" /> {user.languages.join(', ')}</span>
            )}
          </div>

          {/* LinkedIn */}
          {linkedinHref && (
            <a
              href={linkedinHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline bg-blue-50 px-3 py-1.5 rounded-full"
            >
              <Linkedin className="h-3.5 w-3.5" /> linkedin.com/in/{linkedinSlug}
            </a>
          )}
        </div>

        {/* ─── Bio ─── */}
        {user.bio && (
          <Section icon={User} title="About" borderTop>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.bio}</p>
          </Section>
        )}

        {/* ─── Interests ─── */}
        {user.interests?.length > 0 && (
          <Section icon={Sparkles} title="Interests" borderTop>
            <div className="flex flex-wrap gap-1.5">
              {user.interests.map((t: string) => (
                <span key={t} className="px-2.5 py-1 text-xs font-medium bg-rsn-red/5 text-rsn-red border border-rsn-red/10 rounded-full">{t}</span>
              ))}
            </div>
          </Section>
        )}

        {/* ─── Expertise ─── */}
        {user.expertiseText && (
          <Section icon={Award} title="Expertise" borderTop>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.expertiseText}</p>
          </Section>
        )}

        {/* ─── Reasons to Connect ─── */}
        {user.reasonsToConnect?.length > 0 && (
          <Section icon={Link2} title="Reasons to Connect" borderTop>
            <div className="flex flex-wrap gap-1.5">
              {user.reasonsToConnect.map((r: string) => (
                <span key={r} className="px-2.5 py-1 text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100 rounded-full">{r}</span>
              ))}
            </div>
          </Section>
        )}

        {/* ─── Matching Profile ─── */}
        {matchingSections.length > 0 && (
          <div className="border-t border-gray-100">
            <div className="px-6 pt-4 pb-1">
              <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Matching Profile</h3>
            </div>
            <div className="px-6 pb-5 space-y-3">
              {matchingSections.map(({ key, label, Icon, color }) => (
                <div key={key} className="flex gap-3">
                  <div className={`mt-0.5 flex-shrink-0 w-7 h-7 rounded-lg bg-gray-50 flex items-center justify-center ${color}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{user[key]}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Footer accent ─── */}
        <div className="h-1.5 bg-gradient-to-r from-rsn-red via-rose-400 to-amber-400" />
      </div>
    </div>
  );
}

/* ─── Section helper ─── */
function Section({ icon: Icon, title, children, borderTop }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode; borderTop?: boolean }) {
  return (
    <div className={`px-6 py-4 ${borderTop ? 'border-t border-gray-100' : ''}`}>
      <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-rsn-red" /> {title}
      </h3>
      {children}
    </div>
  );
}
