// The words on a pod's page header that come from how the pod is set up. Pure on purpose (no React, axios, store or
// router), so a test can run it: server/src/__tests__/client/pod-wall-client.test.ts.

import { ORCHESTRATION_MODES, effectiveOrchestration } from '@rsn/shared';
import type { OrchestrationMode, PodType } from '@rsn/shared';

/**
 * How the pod's events run, in plain words ("Freeform", "Timed rounds", "Moderated"). The stored mode is read
 * through the pod's type, so an old Reason pod that was saved on timed rounds (which Reason pods do not use)
 * says Freeform, as the pod's forms do, with no update to the stored row. The header used to print the column
 * as it is kept: "timed rounds".
 */
export function orchestrationLabel(pod: { podType: PodType; orchestrationMode?: OrchestrationMode | null }): string {
  return ORCHESTRATION_MODES[effectiveOrchestration(pod)].label;
}

const POD_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  archived: 'Archived',
  suspended: 'Suspended',
  draft: 'Draft',
};

/** The pod's state as the header says it ("Active", "Archived"). It used to print the stored value: "archived". */
export function podStatusLabel(status: string | undefined): string {
  if (!status) return '';
  const known = POD_STATUS_LABELS[status];
  if (known) return known;
  const words = status.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
