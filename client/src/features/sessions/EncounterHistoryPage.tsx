import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Heart, Users, Calendar, Star } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import EmptyState from '@/components/ui/EmptyState';
import api from '@/lib/api';

export default function EncounterHistoryPage() {
  const [mutualOnly, setMutualOnly] = useState(false);

  const { data: encounters, isLoading } = useQuery({
    queryKey: ['encounters', mutualOnly],
    queryFn: () => api.get(`/ratings/encounters?mutualOnly=${mutualOnly}`).then(r => r.data.data ?? []),
  });

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">People</h1>
          <p className="text-gray-500 text-sm mt-1">People you've connected with</p>
        </div>
        <Heart className="h-8 w-8 text-rsn-red" />
      </div>

      {/* Filter */}
      <div className="flex gap-2 animate-fade-in-up">
        <Button
          variant={!mutualOnly ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setMutualOnly(false)}
        >
          <Users className="h-4 w-4 mr-1" /> All Encounters
        </Button>
        <Button
          variant={mutualOnly ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setMutualOnly(true)}
        >
          <Heart className="h-4 w-4 mr-1" /> Mutual Matches
        </Button>
      </div>

      {/* List */}
      {(encounters || []).length === 0 ? (
        <EmptyState
          title={mutualOnly ? 'No mutual matches yet' : 'No encounters yet'}
          description="Join events to start meeting people!"
          icon={<Users className="h-12 w-12" />}
        />
      ) : (
        <div className="grid gap-3 animate-fade-in-up stagger-1">
          {(encounters || []).map((e: any, i: number) => (
            <Card key={e.id || i} className="card-hover">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar name={e.displayName || e.otherUserName || e.email || 'User'} size="md" />
                    {e.mutual && (
                      <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-pink-500 flex items-center justify-center">
                        <Heart className="h-3 w-3 text-white fill-white" />
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-gray-800">{e.displayName || e.otherUserName || 'Someone'}</p>
                    {e.company && <p className="text-xs text-gray-400">{e.jobTitle ? `${e.jobTitle} at ` : ''}{e.company}</p>}
                    {e.sessionTitle && (
                      <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                        <Calendar className="h-3 w-3" />
                        {e.sessionTitle} • {e.sessionDate ? new Date(e.sessionDate).toLocaleDateString() : ''}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {e.rating && (
                    <div className="flex items-center gap-1 text-yellow-400">
                      <Star className="h-4 w-4 fill-yellow-400" />
                      <span className="text-sm">{e.rating}</span>
                    </div>
                  )}
                  {e.mutual && <Badge variant="brand">Mutual</Badge>}
                  {e.connectIntent && <Badge variant="success">Wants to connect</Badge>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
