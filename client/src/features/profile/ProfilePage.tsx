import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { X, User, Briefcase, MapPin, Globe, Languages, Sparkles, Camera, Info } from 'lucide-react';
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
  phone: string;
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
      <label className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">
        {Icon && <Icon className="h-4 w-4 text-gray-400" />}
        {label}
      </label>
      <div className="flex gap-2 mb-2 flex-wrap min-h-[28px]">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-rsn-red-light text-rsn-red px-3 py-1 text-xs font-medium animate-scale-in">
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
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { register, handleSubmit, reset, formState: { isSubmitting, isDirty } } = useForm<ProfileForm>();
  const [tagsChanged, setTagsChanged] = useState(false);

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
        phone: (user as any).phone || '',
      });
      setInterests(user.interests || []);
      setReasons(user.reasonsToConnect || []);
      setLanguages(user.languages || []);
      setTagsChanged(false);
    }
  }, [user]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type and size
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      addToast('Please upload a JPG, PNG, or WebP image', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      addToast('Image must be under 5MB', 'error');
      return;
    }

    setAvatarUploading(true);
    try {
      // Convert to base64 and upload as data URL for now
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        await api.put('/users/me', { avatarUrl: dataUrl });
        await checkSession();
        addToast('Avatar updated!', 'success');
        setAvatarUploading(false);
      };
      reader.onerror = () => {
        addToast('Failed to read image', 'error');
        setAvatarUploading(false);
      };
      reader.readAsDataURL(file);
    } catch {
      addToast('Failed to upload avatar', 'error');
      setAvatarUploading(false);
    }
  };

  const hasChanges = isDirty || tagsChanged;

  const handleSetInterests = (t: string[]) => { setInterests(t); setTagsChanged(true); };
  const handleSetReasons = (t: string[]) => { setReasons(t); setTagsChanged(true); };
  const handleSetLanguages = (t: string[]) => { setLanguages(t); setTagsChanged(true); };

  const normalizeLinkedInUrl = (value: string): string => {
    let v = value.trim();
    if (!v) return '';
    // Strip trailing slashes
    v = v.replace(/\/+$/, '');
    // If it already looks like a URL, return as-is (after trailing slash strip)
    if (/^https?:\/\//i.test(v)) return v;
    // Otherwise treat as a username — strip any leading @ or /in/ prefix users might paste
    v = v.replace(/^@/, '').replace(/^\/?in\//, '');
    return `https://linkedin.com/in/${v}`;
  };

  const isValidLinkedInUrl = (url: string): boolean => {
    if (!url) return true; // optional field on profile
    return /^https?:\/\/(www\.)?linkedin\.com\/in\/.+/i.test(url);
  };

  const onSubmit = async (data: ProfileForm) => {
    // Normalize LinkedIn URL before saving
    data.linkedinUrl = normalizeLinkedInUrl(data.linkedinUrl);
    if (data.linkedinUrl && !isValidLinkedInUrl(data.linkedinUrl)) {
      addToast('Enter your LinkedIn username or full profile URL', 'error');
      return;
    }
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
      <h1 className="text-2xl font-bold text-[#1a1a2e] animate-fade-in">Profile</h1>

      {/* Profile Header Card */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-4 mb-2">
          <div className="relative group">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.displayName || 'Avatar'} className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <Avatar name={user.displayName || user.email} size="xl" />
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
              className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
            >
              <Camera className="h-5 w-5 text-white" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleAvatarUpload}
              className="hidden"
            />
          </div>
          <div>
            <p className="text-lg font-semibold text-[#1a1a2e]">{user.displayName || 'Set your name'}</p>
            <p className="text-sm text-gray-500">{user.email}</p>
            {user.jobTitle && user.company && (
              <p className="text-xs text-gray-400 mt-0.5">{user.jobTitle} at {user.company}</p>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-rsn-red hover:text-rsn-red-hover mt-1 font-medium"
            >
              {avatarUploading ? 'Uploading...' : 'Change photo'}
            </button>
          </div>
        </div>
      </Card>

      {/* Edit Form */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Basic Info */}
        <Card className="animate-fade-in-up stagger-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <User className="h-5 w-5 text-rsn-red" /> Basic Information
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="First Name" {...register('firstName')} placeholder="John" />
            <Input label="Last Name" {...register('lastName')} placeholder="Doe" />
          </div>
          <div className="mt-4">
            <Input label="Display Name" {...register('displayName')} placeholder="How others see you" />
          </div>
          <div className="mt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">
              Email
            </label>
            <div className="flex items-center gap-2">
              <input
                value={user.email}
                disabled
                className="w-full rounded-xl border border-gray-200 bg-gray-100 px-4 py-2.5 text-sm text-gray-500 cursor-not-allowed"
              />
            </div>
            <p className="flex items-center gap-1 text-xs text-gray-400 mt-1">
              <Info className="h-3 w-3" /> Email cannot be changed. It&apos;s tied to your account identity.
            </p>
          </div>
          <div className="mt-4">
            <Input
              label="Phone / WhatsApp"
              placeholder="+1 234 567 8900"
              {...register('phone')}
            />
            <p className="text-xs text-gray-400 mt-1">Optional — for WhatsApp group invites and direct communication</p>
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Bio</label>
            <textarea
              {...register('bio')}
              rows={3}
              placeholder="Tell others about yourself..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
            />
          </div>
        </Card>

        {/* Professional Info */}
        <Card className="animate-fade-in-up stagger-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Briefcase className="h-5 w-5 text-rsn-red" /> Professional
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Job Title" {...register('jobTitle')} placeholder="Product Manager" />
            <Input label="Company" {...register('company')} placeholder="Acme Corp" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <Input label="Industry" {...register('industry')} placeholder="Technology" />
            <Input
              label="LinkedIn"
              {...register('linkedinUrl')}
              placeholder="username or full LinkedIn URL"
            />
          </div>
        </Card>

        {/* Location & Language */}
        <Card className="animate-fade-in-up stagger-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Globe className="h-5 w-5 text-rsn-red" /> Location & Language
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">
                <MapPin className="h-4 w-4 text-gray-400" /> Location
              </label>
              <input
                {...register('location')}
                placeholder="Start typing a city..."
                list="location-options"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200"
              />
              <datalist id="location-options">
                {[
                  'New York, US', 'Los Angeles, US', 'San Francisco, US', 'Chicago, US', 'Miami, US', 'Austin, US', 'Seattle, US', 'Boston, US', 'Denver, US', 'Washington DC, US',
                  'London, UK', 'Manchester, UK', 'Edinburgh, UK',
                  'Berlin, DE', 'Munich, DE', 'Hamburg, DE', 'Frankfurt, DE',
                  'Paris, FR', 'Lyon, FR',
                  'Amsterdam, NL', 'Rotterdam, NL',
                  'Copenhagen, DK', 'Aarhus, DK',
                  'Stockholm, SE', 'Gothenburg, SE',
                  'Oslo, NO', 'Helsinki, FI',
                  'Zurich, CH', 'Geneva, CH',
                  'Barcelona, ES', 'Madrid, ES',
                  'Lisbon, PT', 'Dublin, IE',
                  'Milan, IT', 'Rome, IT',
                  'Vienna, AT', 'Brussels, BE', 'Prague, CZ', 'Warsaw, PL',
                  'Tel Aviv, IL', 'Dubai, AE', 'Singapore, SG', 'Hong Kong, HK',
                  'Tokyo, JP', 'Sydney, AU', 'Melbourne, AU', 'Toronto, CA', 'Vancouver, CA',
                  'São Paulo, BR', 'Mexico City, MX', 'Buenos Aires, AR',
                  'Mumbai, IN', 'Bangalore, IN', 'Bangkok, TH', 'Seoul, KR',
                ].map(city => <option key={city} value={city} />)}
              </datalist>
            </div>
            <Input label="Timezone" {...register('timezone')} placeholder="America/New_York" />
          </div>
          <div className="mt-4">
            <TagInput label="Languages" tags={languages} setTags={handleSetLanguages} placeholder="e.g. english" icon={Languages} />
          </div>
        </Card>

        {/* Tags */}
        <Card className="animate-fade-in-up stagger-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Sparkles className="h-5 w-5 text-rsn-red" /> Interests & Intent
          </h2>
          <div className="space-y-5">
            <TagInput label="Expertise & Interests" tags={interests} setTags={handleSetInterests} placeholder="e.g. react, machine-learning" />
            <TagInput label="Reasons to Connect" tags={reasons} setTags={handleSetReasons} placeholder="e.g. hiring, co-founder search" />
          </div>
        </Card>

        <div className="animate-fade-in-up stagger-5">
          <Button type="submit" isLoading={isSubmitting} disabled={!hasChanges} className="w-full sm:w-auto btn-glow">
            Save Changes
          </Button>
        </div>
      </form>
    </div>
  );
}
