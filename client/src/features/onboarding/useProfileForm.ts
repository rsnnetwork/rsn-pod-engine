// Screen 7's form: what each field shows (typed, else what the profile holds,
// else LinkedIn's suggestion, marked), the time zone, the LinkedIn photo they
// kept, and the profile half of confirm. Held by the flow, not the screen, so
// it survives a trip to [Edit] a question and back.
//
// Nothing here is seeded from the state: a LinkedIn lookup that ends while
// they are still on the questions fills in every field they have not typed in.

import { useRef, useState } from 'react';
import type { OnboardingV2ProfileInput, OnboardingV2State } from '@rsn/shared';
import { browserTimeZone, currentZoneName, isRealZone, profileInput, profileValue, type ProfileFields } from './flow';

const NAME_MISSING = 'Enter your name, as people should see it.';

type FieldKey = keyof ProfileFields | 'timezone';

/** `linkedinOn`: they chose LinkedIn in this visit; otherwise LinkedIn suggests nothing here (useSignupChoice). */
export function useProfileForm(state: OnboardingV2State, linkedinOn: boolean) {
  const [edits, setEdits] = useState<Partial<ProfileFields>>({});
  const [zoneEdit, setZoneEdit] = useState<string | null>(null);
  const [keptPhoto, setKeptPhoto] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  // A refusal from confirm: under the field it is about, or over the whole screen. Changing anything clears it.
  const [refusal, setRefusal] = useState<{ field: FieldKey | null; message: string } | null>(null);
  // "Later" on the LinkedIn card holds while they go to [Edit] a question and come back.
  const [linkedinLater, setLinkedinLater] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const { profile } = state;
  const prefill = linkedinOn ? state.linkedin.prefill : undefined;
  const shown = {
    displayName: profileValue(edits.displayName, profile.displayName, prefill?.displayName),
    jobTitle: profileValue(edits.jobTitle, profile.jobTitle, prefill?.jobTitle),
    company: profileValue(edits.company, profile.company, prefill?.company),
    industry: profileValue(edits.industry, profile.industry, prefill?.industry),
  };
  const zone = zoneEdit ?? (isRealZone(profile.timezone) ? currentZoneName(profile.timezone) : browserTimeZone());
  // Exactly the photo they were shown and kept, and only while they have no photo of their own.
  const keepsLinkedinPhoto = !!keptPhoto && !profile.avatarUrl && keptPhoto === prefill?.photoUrl;

  return {
    shown,
    zone,
    keptPhoto,
    nameRef,
    linkedinLater,
    setLinkedinLater,
    /** What to say under a field, if anything. */
    fieldError: (field: FieldKey): string | null =>
      (field === 'displayName' && nameError) || (refusal?.field === field ? refusal.message : null),
    /** What to say over the whole screen, if anything. */
    formError: refusal && !refusal.field ? refusal.message : null,
    refuse: (field: FieldKey | null, message: string) => setRefusal({ field, message }),
    setField: (field: keyof ProfileFields, value: string) => {
      if (field === 'displayName') setNameError(null);
      setRefusal(null);
      setEdits(e => ({ ...e, [field]: value }));
    },
    setZone: (z: string) => { setRefusal(null); setZoneEdit(z); },
    setKeptPhoto,
    /** The profile half of confirm; null when the name is blank, which it then says, with the cursor there. */
    input: (): OnboardingV2ProfileInput | null => {
      if (!shown.displayName.value.trim()) {
        setNameError(NAME_MISSING);
        nameRef.current?.focus();
        return null;
      }
      const fields: ProfileFields = {
        displayName: shown.displayName.value,
        jobTitle: shown.jobTitle.value,
        company: shown.company.value,
        industry: shown.industry.value,
      };
      return profileInput(fields, isRealZone(zone) ? zone : null, keepsLinkedinPhoto);
    },
  };
}
