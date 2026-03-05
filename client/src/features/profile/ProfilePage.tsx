import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { X } from 'lucide-react';
import api from '@/lib/api';

interface ProfileForm {
  displayName: string;
  bio: string;
}

export default function ProfilePage() {
  const { user, checkSession } = useAuthStore();
  const { addToast } = useToastStore();
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm<ProfileForm>();

  useEffect(() => {
    if (user) {
      reset({ displayName: user.displayName || '', bio: user.bio || '' });
      setTags(user.interests || []);
    }
  }, [user]);

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };

  const onSubmit = async (data: ProfileForm) => {
    try {
      await api.put('/users/me', { ...data, interests: tags });
      await checkSession();
      addToast('Profile updated!', 'success');
    } catch {
      addToast('Failed to update profile', 'error');
    }
  };

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-surface-100">Profile</h1>
      <Card>
        <div className="flex items-center gap-4 mb-6">
          <Avatar name={user.displayName || user.email} size="xl" />
          <div>
            <p className="text-lg font-semibold text-surface-100">{user.displayName || 'Set your name'}</p>
            <p className="text-sm text-surface-400">{user.email}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input label="Display Name" {...register('displayName')} placeholder="Your name" />
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Bio</label>
            <textarea
              {...register('bio')}
              rows={3}
              placeholder="Tell others about yourself..."
              className="w-full rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Expertise Tags</label>
            <div className="flex gap-2 mb-2 flex-wrap">
              {tags.map(t => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-500/20 text-brand-400 px-3 py-1 text-xs font-medium">
                  {t}
                  <button type="button" onClick={() => setTags(tags.filter(x => x !== t))}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={tagInput} onChange={e => setTagInput(e.target.value)}
                placeholder="Add a tag"
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag())}
              />
              <Button type="button" variant="secondary" onClick={addTag}>Add</Button>
            </div>
          </div>

          <Button type="submit" isLoading={isSubmitting}>Save Changes</Button>
        </form>
      </Card>
    </div>
  );
}
