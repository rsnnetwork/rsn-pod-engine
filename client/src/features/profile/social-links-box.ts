// client/src/features/profile/social-links-box.ts
// The four links under LinkedIn on the edit form (10 Nov 2026): Website, Instagram, X and Facebook. Pure on purpose, so a
// test can run it. A box is checked and sent only when the member changed it, the way LinkedIn's is (linkedin-box.ts): an
// address they did not touch never blocks a save and is never rewritten. The server runs the same rule on what arrives.
import { PROFILE_LINK_HELP, parseProfileUrl, type ProfileLinkKind } from '@rsn/shared';

export type SocialField = 'websiteUrl' | 'instagramUrl' | 'xUrl' | 'facebookUrl';

export interface SocialFieldSpec {
  field: SocialField;
  kind: ProfileLinkKind;
  label: string;
  placeholder: string;
}

export const SOCIAL_FIELDS: readonly SocialFieldSpec[] = [
  { field: 'websiteUrl', kind: 'website', label: 'Website', placeholder: 'yourwebsite.com' },
  { field: 'instagramUrl', kind: 'instagram', label: 'Instagram', placeholder: 'instagram.com/your-name' },
  { field: 'xUrl', kind: 'x', label: 'X', placeholder: 'x.com/your-name' },
  { field: 'facebookUrl', kind: 'facebook', label: 'Facebook', placeholder: 'facebook.com/your-name' },
];

export type SocialSave = { kind: 'keep' } | { kind: 'send'; url: string | null } | { kind: 'refuse'; message: string };

/** What a save does with one box: leave it alone (untouched), send the stored form (null clears it), or say what is wrong. */
export function socialSave(spec: SocialFieldSpec, typed: string, changed: boolean): SocialSave {
  if (!changed) return { kind: 'keep' };
  const result = parseProfileUrl(spec.kind, typed);
  return result.ok ? { kind: 'send', url: result.url } : { kind: 'refuse', message: PROFILE_LINK_HELP[spec.kind] };
}
