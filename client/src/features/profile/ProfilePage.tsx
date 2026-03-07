import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { X, User, Briefcase, MapPin, Globe, Languages, Sparkles } from 'lucide-react';
import api from '@/lib/api';

interface ProfileForm {
  displayName: string;
  firstName: string;
  lastName: string;
  bio: string;
  company: string;
  jobTitle: string;
  industry: string;
  location: string;
  linkedinUrl: string;
  timezone: string;
}

function TagInput({ label, tags, setTags, placeholder, icon: Icon }: {
  label: string; tags: string[]; setTags: (t: string[]) => void; placeholder: string; icon?: any;
}) {
  const [input, setInput] = useState('');
  const add = () => {
    const t = input.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setInput('');
  };
  return (
    <div>
      <label className="flex items-center gap-2 text-sm font-medium text-surface-300 mb-1.5">
        {Icon && <Icon className="h-4 w-4 text-surface-500" />}
        {label}
      </label>
      <div className="flex gap-2 mb-2 flex-wrap min-h-[28px]">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-500/20 text-brand-400 px-3 py-1 text-xs font-medium animate-scale-in">
            {t}
            <button type="button" onClick={() => setTags(tags.filter(x => x !== t))} className="hover:text-red-400 transition-colors"><X className="h-3 w-3" /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={input} onChange={e => setInput(e.target.value)}
          placeholder={placeholder}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <Button type="button" variant="secondary" size="sm" onClick={add}>Add</Button>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const { user, checkSession } = useAuthStore();
  const { addToast } = useToastStore();
  const [interests, setInterests] = useState<string[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);

  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm<ProfileForm>();

  useEffect(() => {
    if (user) {
      reset({
        displayName: user.displayName || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        bio: user.bio || '',
        company: user.company || '',
        jobTitle: user.jobTitle || '',
        industry: user.industry || '',
        location: user.location || '',
        linkedinUrl: user.linkedinUrl || '',
        timezone: user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      });
      setInterests(user.interests || []);
      setReasons(user.reasonsToConnect || []);
      setLanguages(user.languages || []);
    }
  }, [user]);

  const onSubmit = async (data: ProfileForm) => {
    try {
      await api.put('/users/me', {
        ...data,
        interests,
        reasonsToConnect: reasons,
        languages,
      });
      await checkSession();
      addToast('Profile updated!', 'success');
    } catch {
      addToast('Failed to update profile', 'error');
    }
  };

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-surface-100 animate-fade-in">Profile</h1>

      {/* Profile Header Card */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-4 mb-2">
          <div className="relative group">
            <Avatar name={user.displayName || user.email} size="xl" />
            <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <User className="h-5 w-5 text-white" />
            </div>
          </div>
          <div>
            <p className="text-lg font-semibold text-surface-100">{user.displayName || 'Set your name'}</p>
            <p className="text-sm text-surface-400">{user.email}</p>
            {user.jobTitle && user.company && (
              <p className="text-xs text-surface-500 mt-0.5">{user.jobTitle} at {user.company}</p>
            )}
          </div>
        </div>
      </Card>

      {/* Edit Form */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Basic Info */}
        <Card className="animate-fade-in-up stagger-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-surface-200 mb-4">
            <User className="h-5 w-5 text-brand-400" /> Basic Information
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="First Name" {...register('firstName')} placeholder="John" />
            <Input label="Last Name" {...register('lastName')} placeholder="Doe" />
          </div>
          <div className="mt-4">
            <Input label="Display Name" {...register('displayName')} placeholder="How others see you" />
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Bio</label>
            <textarea
              {...register('bio')}
              rows={3}
              placeholder="Tell others about yourself..."
              className="w-full rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all duration-200 resize-none"
            />
          </div>
        </Card>

        {/* Professional Info */}
        <Card className="animate-fade-in-up stagger-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-surface-200 mb-4">
            <Briefcase className="h-5 w-5 text-brand-400" /> Professional
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Job Title" {...register('jobTitle')} placeholder="Product Manager" />
            <Input label="Company" {...register('company')} placeholder="Acme Corp" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <Input label="Industry" {...register('industry')} placeholder="Technology" />
            <Input label="LinkedIn URL" {...register('linkedinUrl')} placeholder="https://linkedin.com/in/..." />
          </div>
        </Card>

        {/* Location & Language */}
        <Card className="animate-fade-in-up stagger-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-surface-200 mb-4">
            <Globe className="h-5 w-5 text-brand-400" /> Location & Language
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-surface-300 mb-1.5">
                <MapPin className="h-4 w-4 text-surface-500" /> Location
              </label>
              <input
                {...register('location')}
                placeholder="New York, US"
                className="w-full rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all duration-200"
              />
            </div>
            <Input label="Timezone" {...register('timezone')} placeholder="America/New_York" />
          </div>
          <div className="mt-4">
            <TagInput label="Languages" tags={languages} setTags={setLanguages} placeholder="e.g. english" icon={Languages} />
          </div>
        </Card>

        {/* Tags */}
        <Card className="animate-fade-in-up stagger-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-surface-200 mb-4">
            <Sparkles className="h-5 w-5 text-brand-400" /> Interests & Intent
          </h2>
          <div className="space-y-5">
            <TagInput label="Expertise & Interests" tags={interests} setTags={setInterests} placeholder="e.g. react, machine-learning" />
            <TagInput label="Reasons to Connect" tags={reasons} setTags={setReasons} placeholder="e.g. hiring, co-founder search" />
          </div>
        </Card>

        <div className="animate-fade-in-up stagger-5">
          <Button type="submit" isLoading={isSubmitting} className="w-full sm:w-auto btn-glow">
            Save Changes
          </Button>
        </div>
      </form>
    </div>
  );
}
