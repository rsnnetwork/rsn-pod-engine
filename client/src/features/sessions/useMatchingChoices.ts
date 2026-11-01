// client/src/features/sessions/useMatchingChoices.ts
// The two lists the Matching section chooses from (30 Oct 2026): REASON's speed-networking presets, which any organiser
// may choose (GET /sessions/matching-presets), and, for a platform admin, every template (GET /admin/templates). Both
// follow admin:templates, the tag an admin's template edit sends (D8: the template list had no tag at all).
import { useQuery } from '@tanstack/react-query';
import type { MatchingPreset } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import type { TemplateOption } from './MatchingSection';

export function useMatchingPresets() {
  return useQuery({
    queryKey: ['matching-presets'],
    queryFn: () => api.get('/sessions/matching-presets').then((r) => (r.data.data ?? []) as MatchingPreset[]),
    staleTime: 5 * 60 * 1000,
    meta: { entities: [E.adminTemplates] },
  });
}

export function useMatchingChoices(isAdmin: boolean) {
  const presets = useMatchingPresets();
  const templates = useQuery({
    queryKey: ['admin-templates'],
    queryFn: () => api.get('/admin/templates').then((r) => (r.data.data ?? []) as TemplateOption[]),
    enabled: isAdmin,
    meta: { entities: [E.adminTemplates] },
  });
  return {
    presets: { data: presets.data, isLoading: presets.isLoading, isError: presets.isError, retry: () => { void presets.refetch(); } },
    templates: templates.data,
    templatesLoading: isAdmin && templates.isLoading,
  };
}
