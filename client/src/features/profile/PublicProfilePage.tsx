import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
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

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* ─── Header Card ─── */}
      <Card className="text-center py-8 px-6">
        <Avatar src={user.avatarUrl} name={user.displayName || 'User'} size="xl" />
        <h1 className="mt-4 text-2xl font-bold text-gray-800">{user.displayName}</h1>

        {/* Quick info pills */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-sm text-gray-500">
          {(user.jobTitle || user.company) && (
            <span className="flex items-center gap-1.5">
              <Briefcase className="h-3.5 w-3.5 text-gray-400" />
              {[user.jobTitle, user.company].filter(Boolean).join(' at ')}
            </span>
          )}
          {user.location && (
            <span className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-gray-400" /> {user.location}
            </span>
          )}
          {user.industry && (
            <span className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-gray-400" /> {user.industry}
            </span>
          )}
          {user.languages?.length > 0 && (
            <span className="flex items-center gap-1.5">
              <Languages className="h-3.5 w-3.5 text-gray-400" /> {user.languages.join(', ')}
            </span>
          )}
        </div>

        {/* LinkedIn */}
        {linkedinHref && (
          <a
            href={linkedinHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
          >
            <Linkedin className="h-4 w-4" /> linkedin.com/in/{linkedinSlug}
          </a>
        )}
      </Card>

      {/* ─── Bio ─── */}
      {user.bio && (
        <ProfileSection icon={User} title="About">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.bio}</p>
        </ProfileSection>
      )}

      {/* ─── Interests ─── */}
      {user.interests?.length > 0 && (
        <ProfileSection icon={Sparkles} title="Interests">
          <div className="flex flex-wrap gap-2">
            {user.interests.map((t: string) => (
              <span key={t} className="px-2.5 py-1 text-xs font-medium bg-rsn-red/5 text-rsn-red border border-rsn-red/15 rounded-full">{t}</span>
            ))}
          </div>
        </ProfileSection>
      )}

      {/* ─── Expertise ─── */}
      {user.expertiseText && (
        <ProfileSection icon={Award} title="Expertise">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.expertiseText}</p>
        </ProfileSection>
      )}

      {/* ─── Reasons to Connect ─── */}
      {user.reasonsToConnect?.length > 0 && (
        <ProfileSection icon={Link2} title="Reasons to Connect">
          <div className="flex flex-wrap gap-2">
            {user.reasonsToConnect.map((r: string) => (
              <span key={r} className="px-2.5 py-1 text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100 rounded-full">{r}</span>
            ))}
          </div>
        </ProfileSection>
      )}

      {/* ─── Matching Profile ─── */}
      {user.whatICareAbout && (
        <ProfileSection icon={Heart} title="What I Care About">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.whatICareAbout}</p>
        </ProfileSection>
      )}

      {user.whatICanHelpWith && (
        <ProfileSection icon={HelpCircle} title="What I Can Help With">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.whatICanHelpWith}</p>
        </ProfileSection>
      )}

      {user.whoIWantToMeet && (
        <ProfileSection icon={Users} title="Who I Want to Meet">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.whoIWantToMeet}</p>
        </ProfileSection>
      )}

      {user.whyIWantToMeet && (
        <ProfileSection icon={Target} title="Why I Want to Meet">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.whyIWantToMeet}</p>
        </ProfileSection>
      )}

      {user.myIntent && (
        <ProfileSection icon={Compass} title="My Intent">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{user.myIntent}</p>
        </ProfileSection>
      )}
    </div>
  );
}

/* ─── Reusable section component ─────────────────────────────────────────── */

function ProfileSection({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-rsn-red" /> {title}
      </h3>
      {children}
    </Card>
  );
}
