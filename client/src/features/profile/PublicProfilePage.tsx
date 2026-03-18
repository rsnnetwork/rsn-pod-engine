import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { ArrowLeft, Briefcase, MapPin, Globe, Sparkles, Target, Heart, HelpCircle, Users, MessageSquare } from 'lucide-react';
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

  const linkedinDisplay = user.linkedinUrl
    ? user.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/$/, '')
    : null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* Header */}
      <Card className="text-center py-8">
        <Avatar src={user.avatarUrl} name={user.displayName || 'User'} size="xl" />
        <h1 className="mt-4 text-2xl font-bold text-gray-800">{user.displayName}</h1>
        {(user.jobTitle || user.company) && (
          <p className="mt-1 text-gray-500 flex items-center justify-center gap-1.5">
            <Briefcase className="h-4 w-4" />
            {[user.jobTitle, user.company].filter(Boolean).join(' at ')}
          </p>
        )}
        {user.location && (
          <p className="mt-1 text-gray-400 flex items-center justify-center gap-1.5 text-sm">
            <MapPin className="h-3.5 w-3.5" /> {user.location}
          </p>
        )}
        {user.industry && (
          <p className="mt-1 text-gray-400 flex items-center justify-center gap-1.5 text-sm">
            <Globe className="h-3.5 w-3.5" /> {user.industry}
          </p>
        )}
        {linkedinDisplay && (
          <a
            href={`https://www.linkedin.com/in/${linkedinDisplay}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          >
            linkedin.com/in/{linkedinDisplay}
          </a>
        )}
      </Card>

      {/* Bio */}
      {user.bio && (
        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">About</h3>
          <p className="text-gray-700 text-sm leading-relaxed">{user.bio}</p>
        </Card>
      )}

      {/* Interests & Expertise */}
      {(user.interests?.length > 0 || user.expertiseText) && (
        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-rsn-red" /> Interests & Expertise
          </h3>
          {user.interests?.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {user.interests.map((t: string) => (
                <span key={t} className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-full">{t}</span>
              ))}
            </div>
          )}
          {user.expertiseText && (
            <p className="text-sm text-gray-600">{user.expertiseText}</p>
          )}
        </Card>
      )}

      {/* Matching Profile fields */}
      {[
        { key: 'whatICareAbout', label: 'What I Care About', icon: Heart },
        { key: 'whatICanHelpWith', label: 'What I Can Help With', icon: HelpCircle },
        { key: 'whoIWantToMeet', label: 'Who I Want to Meet', icon: Users },
        { key: 'whyIWantToMeet', label: 'Why I Want to Meet', icon: Target },
        { key: 'myIntent', label: 'My Intent', icon: MessageSquare },
      ].filter(f => user[f.key]).map(f => (
        <Card key={f.key}>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
            <f.icon className="h-4 w-4 text-rsn-red" /> {f.label}
          </h3>
          <p className="text-sm text-gray-700 leading-relaxed">{user[f.key]}</p>
        </Card>
      ))}
    </div>
  );
}
