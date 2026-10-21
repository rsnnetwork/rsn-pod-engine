// client/src/features/reason/entities/EntityMark.tsx
// The tile with the entity's first letter, where a logo would be (the v4 prototype's .company-mark). Inter is loaded
// up to 800, so the prototype's 900 weight is drawn as extrabold.
import { cn } from '@/lib/utils';
import { entityLetter } from './entity-text';

const SIZES = {
  // A card in a list.
  card: 'h-[52px] w-[52px] rounded-[14px] bg-[#111216] text-[20px] text-white min-[721px]:h-[56px] min-[721px]:w-[56px] min-[721px]:rounded-[15px] min-[721px]:text-[21px]',
  // The white tile on the hero's dark panel.
  hero: 'h-[74px] w-[74px] rounded-[19px] bg-white text-[29px] text-[#111216] min-[981px]:h-[112px] min-[981px]:w-[112px] min-[981px]:rounded-[28px] min-[981px]:text-[42px]',
  // A row in a short list (a person's entities, the create form's "already on REASON").
  row: 'h-[38px] w-[38px] rounded-[11px] bg-[#111216] text-[15px] text-white',
} as const;

export default function EntityMark({ name, size }: { name: string; size: keyof typeof SIZES }) {
  // It sits beside the name, never instead of it, so a screen reader skips it.
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center font-extrabold leading-none tracking-[-0.04em]', SIZES[size])}>
      {entityLetter(name)}
    </span>
  );
}
