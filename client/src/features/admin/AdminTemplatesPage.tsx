import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Plus, Pencil, Trash2, Star } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { PageLoader } from '@/components/ui/Spinner';
import Modal from '@/components/ui/Modal';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';

// Phase 3 — templates now configure the FULL engine weight set (was 5 lossy
// columns). Keys match the engine's MatchingWeights exactly and ride in a JSONB
// `weights` blob, so adding a future signal needs no migration.
const WEIGHT_GROUPS: { group: string; keys: [string, string][] }[] = [
  { group: 'Relevance', keys: [
    ['intentAlignment', 'Who they want to meet'],
    ['eventIntentionAlignment', "Today's check-in intent"],
    ['sharedReasons', 'Shared reasons to connect'],
    ['sharedInterests', 'Shared interests'],
    ['designationDiversity', 'Complementary roles (founder ↔ investor)'],
  ] },
  { group: 'Diversity', keys: [
    ['industryDiversity', 'Different industries'],
    ['companyDiversity', 'Different companies'],
    ['languageMatch', 'Shared language'],
  ] },
  { group: 'Guardrails', keys: [
    ['avoidPenalty', 'Respect "who I want to avoid"'],
  ] },
  { group: 'Premium', keys: [
    ['mutualPremiumRequest', 'Mutual premium request'],
    ['singlePremiumRequest', 'Single premium request'],
    ['premiumBoost', 'General premium boost'],
  ] },
  { group: 'Freshness & learning', keys: [
    ['encounterFreshness', 'Prefer fresh pairings'],
    ['mutualMeetAgainBoost', 'Re-pair past "meet again"'],
  ] },
];

const DEFAULT_WEIGHTS: Record<string, number> = {
  sharedInterests: 0.25, sharedReasons: 0.25, industryDiversity: 0.15, companyDiversity: 0.15,
  languageMatch: 0.10, encounterFreshness: 0.10, mutualMeetAgainBoost: 0.05,
  mutualPremiumRequest: 0.20, singlePremiumRequest: 0.10, premiumBoost: 0.03,
  intentAlignment: 0.20, designationDiversity: 0.10, avoidPenalty: 0.15, eventIntentionAlignment: 0.15,
};

const PRESETS: Record<string, Record<string, number>> = {
  'Balanced (default)': { ...DEFAULT_WEIGHTS },
  'Investor Day': { ...DEFAULT_WEIGHTS, intentAlignment: 0.30, designationDiversity: 0.25, eventIntentionAlignment: 0.25, sharedReasons: 0.15, sharedInterests: 0.10, industryDiversity: 0.05, avoidPenalty: 0.20 },
  'Mentorship': { ...DEFAULT_WEIGHTS, designationDiversity: 0.30, intentAlignment: 0.25, sharedReasons: 0.20, eventIntentionAlignment: 0.20, industryDiversity: 0.05 },
  'Pure networking': { ...DEFAULT_WEIGHTS, industryDiversity: 0.30, companyDiversity: 0.25, encounterFreshness: 0.20, sharedInterests: 0.20, intentAlignment: 0.10, designationDiversity: 0.10 },
};

interface TemplateForm {
  name: string;
  description: string;
  weights: Record<string, number>;
  matchingPolicy: string;
  cooldownMonths: number;
  sameCompanyAllowed: boolean;
  fallbackStrategy: string;
}
const DEFAULTS: TemplateForm = {
  name: '', description: '', weights: { ...DEFAULT_WEIGHTS },
  matchingPolicy: 'within_event', cooldownMonths: 12, sameCompanyAllowed: false, fallbackStrategy: 'random',
};

const selectClass = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

function WeightSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-600">{label}</label>
        <span className="text-xs text-gray-400">{Math.round((value ?? 0) * 100)}%</span>
      </div>
      <input
        type="range" min="0" max="100" value={Math.round((value ?? 0) * 100)}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-rsn-red"
      />
    </div>
  );
}

// Read a template's weights, preferring the JSONB blob, falling back to the
// legacy 5 columns for pre-Phase-3 rows.
function readWeights(t: any): Record<string, number> {
  const base = { ...DEFAULT_WEIGHTS };
  if (t?.weights && typeof t.weights === 'object') return { ...base, ...t.weights };
  return {
    ...base,
    sharedInterests: t?.weightInterests ?? base.sharedInterests,
    sharedReasons: t?.weightIntent ?? base.sharedReasons,
    industryDiversity: t?.weightIndustry ?? base.industryDiversity,
    languageMatch: t?.weightLocation ?? base.languageMatch,
    encounterFreshness: t?.weightExperience ?? base.encounterFreshness,
  };
}

export default function AdminTemplatesPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editModal, setEditModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>(DEFAULTS);

  const { data: templates, isLoading } = useQuery({
    queryKey: ['admin-templates'],
    queryFn: () => api.get('/admin/templates').then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name, description: form.description, weights: form.weights,
        matchingPolicy: form.matchingPolicy,
        cooldownMonths: form.matchingPolicy === 'cooldown' ? form.cooldownMonths : undefined,
        sameCompanyAllowed: form.sameCompanyAllowed, fallbackStrategy: form.fallbackStrategy,
      };
      return editId ? api.put(`/admin/templates/${editId}`, payload) : api.post('/admin/templates', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-templates'] });
      addToast(editId ? 'Template updated' : 'Template created', 'success');
      setEditModal(false);
    },
    onError: () => addToast('Failed to save template', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/templates/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-templates'] }); addToast('Template deleted', 'success'); },
  });

  const openCreate = () => { setEditId(null); setForm(DEFAULTS); setEditModal(true); };
  const openEdit = (t: any) => {
    setEditId(t.id);
    setForm({
      name: t.name, description: t.description || '',
      weights: readWeights(t),
      matchingPolicy: t.matchingPolicy || 'within_event',
      cooldownMonths: t.cooldownMonths ?? 12,
      sameCompanyAllowed: t.sameCompanyAllowed ?? false,
      fallbackStrategy: t.fallbackStrategy || 'random',
    });
    setEditModal(true);
  };
  const setW = (k: string, v: number) => setForm(f => ({ ...f, weights: { ...f.weights, [k]: v } }));
  const applyPreset = (name: string) => { const p = PRESETS[name]; if (p) setForm(f => ({ ...f, weights: { ...p } })); };

  if (!isAdmin(user?.role)) {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <Shield className="h-16 w-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Admin Only</h2>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 px-4 sm:px-0">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Matching Templates</h1>
          <p className="text-gray-500 text-sm mt-1">Configure how participants are matched in events</p>
        </div>
        <Button onClick={openCreate} className="btn-glow">
          <Plus className="h-4 w-4 mr-2" /> New Template
        </Button>
      </div>

      {isLoading ? <PageLoader /> : (
        <div className="space-y-3 animate-fade-in-up">
          {(templates || []).map((t: any) => {
            const w = readWeights(t);
            return (
              <Card key={t.id} className="!p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-semibold text-gray-800">{t.name}</p>
                      {t.isDefault && <Badge variant="brand"><Star className="h-3 w-3 mr-1" /> Default</Badge>}
                    </div>
                    {t.description && <p className="text-sm text-gray-500 mb-3">{t.description}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span><span className="text-gray-400">Intent</span> <span className="font-medium">{Math.round(w.intentAlignment * 100)}%</span></span>
                      <span><span className="text-gray-400">Check-in</span> <span className="font-medium">{Math.round(w.eventIntentionAlignment * 100)}%</span></span>
                      <span><span className="text-gray-400">Roles</span> <span className="font-medium">{Math.round(w.designationDiversity * 100)}%</span></span>
                      <span><span className="text-gray-400">Industry</span> <span className="font-medium">{Math.round(w.industryDiversity * 100)}%</span></span>
                      <span><span className="text-gray-400">Avoid</span> <span className="font-medium">{Math.round(w.avoidPenalty * 100)}%</span></span>
                    </div>
                    <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-400">
                      <span>Policy: {t.matchingPolicy || 'within_event'}</span>
                      {t.matchingPolicy === 'cooldown' && <span>Cooldown: {t.cooldownMonths ?? 12} mo</span>}
                      <span>Same company: {t.sameCompanyAllowed ? 'Yes' : 'No'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button aria-label="Edit template" onClick={() => openEdit(t)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700">
                      <Pencil className="h-4 w-4" />
                    </button>
                    {!t.isDefault && (
                      <button aria-label="Delete template" onClick={() => { if (confirm('Delete this template?')) deleteMutation.mutate(t.id); }} className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
          {(!templates || templates.length === 0) && (
            <Card><p className="text-gray-400 text-sm text-center py-8">No templates yet. Create one to get started.</p></Card>
          )}
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal open={editModal} onClose={() => setEditModal(false)} title={editId ? 'Edit Template' : 'New Template'}>
        <div className="space-y-4 max-h-[72vh] overflow-y-auto pr-1">
          <Input label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Investor Day" />
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Description</label>
            <textarea
              value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2} placeholder="What is this template for?"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Start from a preset</label>
            <select className={selectClass} defaultValue="" onChange={e => { if (e.target.value) applyPreset(e.target.value); }}>
              <option value="">Choose a preset…</option>
              {Object.keys(PRESETS).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          {WEIGHT_GROUPS.map(g => (
            <div key={g.group}>
              <h3 className="text-sm font-semibold text-gray-700 pt-2 pb-1">{g.group}</h3>
              <div className="space-y-3">
                {g.keys.map(([key, label]) => (
                  <WeightSlider key={key} label={label} value={form.weights[key] ?? 0} onChange={v => setW(key, v)} />
                ))}
              </div>
            </div>
          ))}

          <h3 className="text-sm font-semibold text-gray-700 pt-2">Matching behaviour</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Re-match policy</label>
              <select value={form.matchingPolicy} onChange={e => setForm(f => ({ ...f, matchingPolicy: e.target.value }))} className={selectClass}>
                <option value="within_event">Within event only</option>
                <option value="platform_wide">Never re-match (platform-wide)</option>
                <option value="cooldown">Cooldown (months)</option>
                <option value="none">No restriction</option>
              </select>
            </div>
            {form.matchingPolicy === 'cooldown' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Cooldown (months)</label>
                <input type="number" min={1} max={60} value={form.cooldownMonths}
                  onChange={e => setForm(f => ({ ...f, cooldownMonths: parseInt(e.target.value) || 12 }))}
                  className={selectClass} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Fallback strategy</label>
              <select value={form.fallbackStrategy} onChange={e => setForm(f => ({ ...f, fallbackStrategy: e.target.value }))} className={selectClass}>
                <option value="random">Random</option>
                <option value="round_robin">Round Robin</option>
                <option value="least_matched">Least Matched</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={form.sameCompanyAllowed}
                  onChange={e => setForm(f => ({ ...f, sameCompanyAllowed: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red" />
                Allow same-company matches
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEditModal(false)}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} isLoading={saveMutation.isPending} disabled={!form.name}>
              {editId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
