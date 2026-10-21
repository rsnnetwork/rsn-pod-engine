import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useAuthStore } from '@/stores/authStore';
import LinkedinPhotoOffer, { useLinkedinPhoto } from '@/features/onboarding/LinkedinPhotoOffer';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { X, User, Briefcase, MapPin, Globe, Languages, Sparkles, Camera, Info, Target, Heart, HelpCircle, Users, MessageSquare, ArrowLeft } from 'lucide-react';
import api from '@/lib/api';
import OnboardingWelcomeModal from '@/features/onboarding/OnboardingWelcomeModal';
import { Skeleton } from '@/components/ui/Spinner';
import { useOnboardingV2State } from '@/features/onboarding/useOnboardingV2';
import { EDIT_ANSWERS_TO, answerLines } from '@/features/reason/profile/your-profile-text';
import { LINKEDIN_LINK_HELP } from '@/features/auth/linkedin-link';
import { linkedinBoxValue, linkedinSave } from './linkedin-box';

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
  expertiseText: string;
  whatICareAbout: string;
  whyIWantToMeet: string;
}

// What the member can offer, would like to meet and is hoping to find come from their answers to the onboarding
// questions, and the next save of those answers writes over them (final review, 21 Oct 2026): a change made here was
// lost, and no search reads them. So the answers themselves are shown, as Your profile shows them (the short labels,
// their own words in quotes), never the wording the matcher keeps for them, with the way to change them.
const ANSWER_ROWS = [
  { label: 'What I can help with', icon: HelpCircle, step: 'q3' },
  { label: 'Who I want to meet', icon: Users, step: 'q1' },
  { label: 'My intent', icon: Target, step: 'q2' },
] as const;

function FromYourAnswers() {
  // The onboarding's own state (user:<you>), which a changed answer on any of your devices refreshes.
  const state = useOnboardingV2State();
  return (
    <section aria-labelledby="from-your-answers" className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h3 id="from-your-answers" className="text-sm font-semibold text-gray-800">From your answers</h3>
        <Link to={EDIT_ANSWERS_TO} className="inline-flex min-h-[44px] items-center text-sm font-semibold text-rsn-red hover:text-rsn-red-hover">Edit answers</Link>
      </div>
      <p className="text-xs text-gray-600">These come from your answers to the questions. Change them there.</p>
      {state.data ? (
        <dl className="mt-3 space-y-3">
          {ANSWER_ROWS.map(({ label, icon: Icon, step }) => {
            const lines = answerLines(step, state.data.answers);
            return (
              <div key={label}>
                <dt className="flex items-center gap-2 text-sm font-medium text-gray-600">
                  <Icon className="h-4 w-4 text-gray-400" aria-hidden /> {label}
                </dt>
                {(lines.length ? lines : ['Not answered yet.']).map((line, i) => (
                  <dd key={`${i}-${line}`} className="mt-1 text-sm leading-relaxed text-[#1a1a2e] [overflow-wrap:anywhere]">{line}</dd>
                ))}
              </div>
            );
          })}
        </dl>
      ) : state.isError ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-700">We could not load your answers just now.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void state.refetch()} className="min-h-[44px]">Try again</Button>
        </div>
      ) : (
        <div className="mt-3 space-y-3" aria-busy="true">
          <span className="sr-only" role="status">Loading your answers</span>
          {ANSWER_ROWS.map(({ label }) => <Skeleton key={label} className="h-[44px] rounded-lg" />)}
        </div>
      )}
    </section>
  );
}

// 21 Oct 2026: a phone photo of 1.5 to 5 MB, sent as it was, went over the server's cap on avatarUrl. The
// upload was awaited inside reader.onload, outside the try, so the refusal was never caught, nothing was said
// and "Uploading..." stayed on screen for good. The photo is now made smaller here first (it is never shown
// larger than 800x800), and every way the upload can end is caught, said, and puts the button back.
const PHOTO_MAX_SIDE = 800;
const PHOTO_QUALITY = 0.85;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This picture could not be read')); };
    img.src = url;
  });
}

/** The photo as a JPEG data URL, scaled down (never up) to fit 800 by 800. */
async function shrinkPhoto(file: File): Promise<string> {
  const img = await loadImage(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / img.naturalWidth, PHOTO_MAX_SIDE / img.naturalHeight);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This picture could not be read');
  // A JPEG has no transparency: a see-through PNG would turn black without a white ground under it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
}

/** What a failed photo upload says: the server's own sentence when it sent one, plain words otherwise. */
function photoUploadError(err: unknown): string {
  const failed = (err ?? {}) as { response?: { data?: { error?: { message?: unknown } } }; request?: unknown };
  const message = failed.response?.data?.error?.message;
  // The form check's label is not a sentence, and the only check on a photo is its size.
  if (message === 'Validation failed') return 'That photo is too large. Please choose a smaller one.';
  if (typeof message === 'string' && message.trim()) return message;
  if (failed.response) return 'Could not update your photo. Please try again.';
  if (failed.request) return 'Could not update your photo. Check your connection and try again.';
  return 'We could not read that photo. Please choose another one.';
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

  // 7 Sep 2026 (Ali: "where is the card on my profile?"): the same Google
  // photo tap as the onboarding card, from the profile page, with the
  // outcome read back from the URL on return.
  const [googlePhotoBusy, setGooglePhotoBusy] = useState(false);
  // 23 Sep 2026: the LinkedIn photo is a choice, never applied for them. Here
  // it is one tap from the profile for anyone who skipped it at sign-up.
  const { data: linkedinPhoto } = useLinkedinPhoto();
  const [linkedinOpen, setLinkedinOpen] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const photo = params.get('photo');
    if (!photo) return;
    params.delete('photo');
    const rest = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    if (photo === 'done') { void checkSession(); addToast('Photo added from your Google account.', 'success'); }
    else if (photo === 'none') addToast('That Google account has no photo.', 'info');
    else if (photo === 'cancelled') addToast('No problem, nothing changed.', 'info');
    else addToast('Could not fetch the Google photo.', 'error');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function useGooglePhoto() {
    if (googlePhotoBusy) return;
    setGooglePhotoBusy(true);
    try {
      // The form lives at /profile/edit (21 Oct 2026), and the outcome is read here, so Google brings you back here.
      const res = await api.post('/auth/google/photo-state', { redirect: '/profile/edit' });
      window.location.href = res.data?.data?.url;
    } catch {
      setGooglePhotoBusy(false);
      addToast('Google sign-in is not available right now.', 'error');
    }
  }
  const [interests, setInterests] = useState<string[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Your profile's "connect LinkedIn" card links to /profile/edit#linkedin: bring the field into view and put the
  // cursor in it (21 Oct 2026). The page area scrolls, not the window, so the field is scrolled into view itself.
  const { hash } = useLocation();
  const userId = user?.id;
  useEffect(() => {
    if (hash === '#linkedin' && userId) {
      const field = document.getElementById('linkedin');
      field?.scrollIntoView({ block: 'center' });
      field?.focus({ preventScroll: true });
    }
  }, [hash, userId]);

  const { register, handleSubmit, reset, setError, formState: { isSubmitting, isDirty, errors, dirtyFields } } = useForm<ProfileForm>();
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
        linkedinUrl: linkedinBoxValue(user.linkedinUrl),
        timezone: user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        phone: (user as any).phone || '',
        expertiseText: (user as any).expertiseText || '',
        whatICareAbout: (user as any).whatICareAbout || '',
        whyIWantToMeet: (user as any).whyIWantToMeet || '',
      });
      setInterests(user.interests || []);
      setReasons(user.reasonsToConnect || []);
      setLanguages(user.languages || []);
      setTagsChanged(false);
    }
  }, [user]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // Cleared at once, so the same photo can be chosen again after a failure.
    input.value = '';
    if (!file) return;

    // Validate file type and size
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      addToast('Please upload a JPG, PNG, or WebP image', 'error');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      addToast('Image must be under 20MB', 'error');
      return;
    }

    setAvatarUploading(true);
    try {
      const avatarUrl = await shrinkPhoto(file);
      await api.put('/users/me', { avatarUrl });
      await checkSession();
      addToast('Avatar updated!', 'success');
    } catch (err) {
      addToast(photoUploadError(err), 'error');
    } finally {
      setAvatarUploading(false);
    }
  };

  const hasChanges = isDirty || tagsChanged;

  const handleSetInterests = (t: string[]) => { setInterests(t); setTagsChanged(true); };
  const handleSetReasons = (t: string[]) => { setReasons(t); setTagsChanged(true); };
  const handleSetLanguages = (t: string[]) => { setLanguages(t); setTagsChanged(true); };

  const onSubmit = async (data: ProfileForm) => {
    // LinkedIn is checked and sent only when the member changed the box (linkedin-box.ts): then the request form's
    // clean-up makes it https://www.linkedin.com/in/<name>, an emptied box sends '', and anything else is said under the
    // field. An address they did not touch never blocks a save and is never rewritten.
    const { linkedinUrl: typedLinkedin, ...fields } = data;
    const linkedin = linkedinSave(typedLinkedin, !!dirtyFields.linkedinUrl);
    if (linkedin.kind === 'refuse') {
      setError('linkedinUrl', { message: LINKEDIN_LINK_HELP }, { shouldFocus: true });
      return;
    }
    try {
      await api.put('/users/me', {
        ...fields,
        ...(linkedin.kind === 'send' ? { linkedinUrl: linkedin.url } : {}),
        interests,
        reasonsToConnect: reasons,
        languages,
        expertiseText: data.expertiseText || null,
        whatICareAbout: data.whatICareAbout || null,
        whyIWantToMeet: data.whyIWantToMeet || null,
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
      <OnboardingWelcomeModal />
      <div>
        <Link to="/profile" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> Back to your profile
        </Link>
        <h1 className="text-2xl font-bold text-[#1a1a2e] animate-fade-in">Profile</h1>
      </div>

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
            <div className="flex flex-wrap items-center gap-x-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-[44px] items-center text-xs text-rsn-red hover:text-rsn-red-hover font-medium"
              >
                {avatarUploading ? 'Uploading...' : 'Change photo'}
              </button>
              <button
                type="button"
                onClick={useGooglePhoto}
                disabled={googlePhotoBusy}
                className="inline-flex min-h-[44px] items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-[#1a1a2e] disabled:opacity-50"
                data-testid="use-google-photo"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" aria-hidden>
                  <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z" />
                  <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
                  <path fill="#FBBC05" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9l3.3-2.5z" />
                  <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10c.8-2.3 3-4 5.6-4z" />
                </svg>
                Use my Google photo
              </button>
              {linkedinPhoto && !linkedinOpen && (
                <button
                  type="button"
                  onClick={() => setLinkedinOpen(true)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-[#1a1a2e]"
                  data-testid="use-linkedin-photo"
                >
                  Use my LinkedIn photo
                </button>
              )}
            </div>
            {linkedinOpen && (
              <div className="mt-3">
                <LinkedinPhotoOffer
                  onUsed={() => setLinkedinOpen(false)}
                  onDismiss={() => setLinkedinOpen(false)}
                />
              </div>
            )}
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
            <label className="block text-sm font-medium text-gray-600 mb-1.5">About / Bio</label>
            <textarea
              {...register('bio')}
              rows={6}
              placeholder="Tell others who you are and what you do, so they can understand you before connecting..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm leading-relaxed text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-y"
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
            <div>
              <label htmlFor="linkedin" className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">LinkedIn</label>
              <div className="flex items-center rounded-xl border border-gray-200 bg-gray-50 overflow-hidden focus-within:ring-2 focus-within:ring-[#1a1a2e] transition-all duration-200">
                <span className="pl-4 pr-1 text-sm text-gray-400 whitespace-nowrap select-none">linkedin.com/in/</span>
                <input
                  id="linkedin"
                  {...register('linkedinUrl')}
                  placeholder="your-username"
                  aria-invalid={errors.linkedinUrl ? true : undefined}
                  aria-describedby={errors.linkedinUrl ? 'linkedin-error' : undefined}
                  className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none"
                />
              </div>
              {errors.linkedinUrl?.message && (
                <p id="linkedin-error" role="alert" className="mt-1 text-xs text-red-700">{errors.linkedinUrl.message}</p>
              )}
            </div>
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
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">
                <MessageSquare className="h-4 w-4 text-gray-400" /> Expertise (detailed)
              </label>
              <textarea
                {...register('expertiseText')}
                rows={3}
                placeholder="Describe your expertise in more detail — this helps with AI-based matching..."
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
              />
            </div>
            <TagInput label="Reasons to Connect" tags={reasons} setTags={handleSetReasons} placeholder="e.g. hiring, co-founder search" />
          </div>
        </Card>

        {/* Matching Signals */}
        <Card className="animate-fade-in-up stagger-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Target className="h-5 w-5 text-rsn-red" /> Matching Profile
          </h2>
          <p className="text-xs text-gray-400 mb-4">This information helps us match you with the right people. The more you share, the better your matches.</p>
          <div className="space-y-4">
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">
                <Heart className="h-4 w-4 text-gray-400" /> What I care about
              </label>
              <textarea
                {...register('whatICareAbout')}
                rows={2}
                placeholder="What topics, causes, or goals are most important to you?"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-600 mb-1.5">
                Why I want to meet them
              </label>
              <textarea
                {...register('whyIWantToMeet')}
                rows={2}
                placeholder="What are you hoping to get out of these connections?"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
              />
            </div>
            <FromYourAnswers />
          </div>
        </Card>

        <div className="animate-fade-in-up stagger-6">
          <Button type="submit" isLoading={isSubmitting} disabled={!hasChanges} className="w-full sm:w-auto btn-glow">
            Save Changes
          </Button>
        </div>
      </form>
    </div>
  );
}
