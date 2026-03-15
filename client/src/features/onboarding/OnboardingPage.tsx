import { useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { User, Briefcase, Sparkles, ArrowRight, ArrowLeft, X, Check } from 'lucide-react';
import api from '@/lib/api';

const STEPS = [
  { title: 'Who are you?', icon: User, description: 'Let others know who they\'re meeting' },
  { title: 'What do you do?', icon: Briefcase, description: 'Your professional context helps with matching' },
  { title: 'Why are you here?', icon: Sparkles, description: 'Help us connect you with the right people' },
];

function TagInput({ tags, setTags, placeholder }: { tags: string[]; setTags: (t: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('');
  const add = () => {
    const t = input.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setInput('');
  };
  return (
    <div>
      <div className="flex gap-2 mb-2 flex-wrap min-h-[28px]">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-rsn-red-light text-rsn-red px-3 py-1 text-xs font-medium">
            {t}
            <button type="button" onClick={() => setTags(tags.filter(x => x !== t))} className="hover:text-red-400 transition-colors"><X className="h-3 w-3" /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={placeholder}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={add}>Add</Button>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/';
  const { user, checkSession } = useAuthStore();
  const { addToast } = useToastStore();

  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 1 fields
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [firstName, setFirstName] = useState(user?.firstName || '');
  const [lastName, setLastName] = useState(user?.lastName || '');

  // Step 2 fields
  const [jobTitle, setJobTitle] = useState(user?.jobTitle || '');
  const [company, setCompany] = useState(user?.company || '');
  const [industry, setIndustry] = useState(user?.industry || '');

  // Step 3 fields
  const [reasons, setReasons] = useState<string[]>(user?.reasonsToConnect || []);
  const [interests, setInterests] = useState<string[]>(user?.interests || []);

  const canProceed = step === 0
    ? displayName.trim().length > 0
    : step === 1
      ? true // professional info is optional
      : reasons.length > 0;

  const handleFinish = useCallback(async () => {
    setSaving(true);
    try {
      await api.put('/users/me', {
        displayName: displayName.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        jobTitle: jobTitle.trim(),
        company: company.trim(),
        industry: industry.trim(),
        reasonsToConnect: reasons,
        interests,
      });
      await checkSession();
      addToast('Profile set up!', 'success');
      navigate(redirect, { replace: true });
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Failed to save profile', 'error');
    } finally {
      setSaving(false);
    }
  }, [displayName, firstName, lastName, jobTitle, company, industry, reasons, interests, checkSession, addToast, navigate, redirect]);

  const StepIcon = STEPS[step].icon;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-white to-gray-50/50 p-4">
      <div className="max-w-md w-full">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all duration-300 ${
                i === step ? 'w-8 bg-rsn-red' : i < step ? 'w-2 bg-rsn-red/40' : 'w-2 bg-gray-200'
              }`}
            />
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 animate-fade-in">
          {/* Header */}
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-rsn-red-light text-rsn-red mx-auto mb-3">
              <StepIcon className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold text-[#1a1a2e]">{STEPS[step].title}</h2>
            <p className="text-gray-500 text-sm mt-1">{STEPS[step].description}</p>
          </div>

          {/* Step content */}
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Display Name *</label>
                <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="How you want to appear" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">First Name</label>
                  <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">Last Name</label>
                  <Input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last" />
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Job Title</label>
                <Input value={jobTitle} onChange={e => setJobTitle(e.target.value)} placeholder="e.g. Product Manager" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Company</label>
                <Input value={company} onChange={e => setCompany(e.target.value)} placeholder="Where you work" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Industry</label>
                <Input value={industry} onChange={e => setIndustry(e.target.value)} placeholder="e.g. Technology, Finance" />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Why do you want to connect? *</label>
                <TagInput tags={reasons} setTags={setReasons} placeholder="e.g. meet founders, find partners" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Your interests</label>
                <TagInput tags={interests} setTags={setInterests} placeholder="e.g. AI, startups, design" />
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between mt-8 pt-4 border-t border-gray-100">
            {step > 0 ? (
              <button onClick={() => setStep(step - 1)} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            ) : (
              <button onClick={() => navigate(redirect, { replace: true })} className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
                Skip for now
              </button>
            )}

            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep(step + 1)} disabled={!canProceed} size="sm">
                Next <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <Button onClick={handleFinish} isLoading={saving} disabled={!canProceed} size="sm">
                <Check className="h-4 w-4 mr-1" /> Finish
              </Button>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">Step {step + 1} of {STEPS.length}</p>
      </div>
    </div>
  );
}
