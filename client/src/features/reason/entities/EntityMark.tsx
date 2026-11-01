// client/src/features/reason/entities/EntityMark.tsx
// The entity's tile (the v4 prototype's .company-mark): its logo when it has one (30 Oct review, 7.1: "upload a
// company logo"), else its first letter. A logo is drawn on a white tile with the line border at every size, so a dark
// logo never vanishes on the dark card and row tiles; a logo that fails to load draws the letter, the way a failed
// photo draws initials. Inter is loaded up to 800, so the prototype's 900 weight is drawn as extrabold.
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { entityLetter } from './entity-text';

// Each size's box (the same for the logo and the letter), then each size's letter colours and type.
const BOX = {
  // A card in a list.
  card: 'h-[52px] w-[52px] rounded-[14px] min-[721px]:h-[56px] min-[721px]:w-[56px] min-[721px]:rounded-[15px]',
  // The white tile on the hero's dark panel.
  hero: 'h-[74px] w-[74px] rounded-[19px] min-[981px]:h-[112px] min-[981px]:w-[112px] min-[981px]:rounded-[28px]',
  // A row in a short list (a person's entities, the create form's "already on REASON", a circle's organisations).
  row: 'h-[38px] w-[38px] rounded-[11px]',
} as const;
const LETTER = {
  card: 'bg-[#111216] text-[20px] text-white min-[721px]:text-[21px]',
  hero: 'bg-white text-[29px] text-[#111216] min-[981px]:text-[42px]',
  row: 'bg-[#111216] text-[15px] text-white',
} as const;

interface Props {
  name: string;
  size: keyof typeof BOX;
  /** The entity's logo (an absolute, versioned address), or null for the letter. */
  logoUrl?: string | null;
}

export default function EntityMark({ name, size, logoUrl }: Props) {
  // Which logo failed is remembered, so a new logo (a new address) is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  // It sits beside the name, never instead of it, so a screen reader skips it.
  if (logoUrl && logoUrl !== failed) {
    return (
      <span aria-hidden="true" data-entity-logo="" className={cn('grid shrink-0 place-items-center overflow-hidden border border-reason-line bg-white', BOX[size])}>
        <img src={logoUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(logoUrl)} className="h-full w-full object-cover" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center font-extrabold leading-none tracking-[-0.04em]', BOX[size], LETTER[size])}>
      {entityLetter(name)}
    </span>
  );
}
