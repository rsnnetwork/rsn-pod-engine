import { cn } from '@/lib/utils';

// The official sheep, unaltered (reason-mark-small.png: OFFICIAL_LOGO_REFERENCE.png downscaled at 12x onto a
// canvas with a 3% margin, so no edge is ever cut; 1 Nov 2026), and the REASON wordmark beside it: one line, the
// two centred on each other. "rail" hides the words at 721–980px.
export default function ReasonMark({ variant = 'full' }: { variant?: 'full' | 'rail' | 'mobile' }) {
  const phone = variant === 'mobile';
  return (
    <span className="flex min-w-0 items-center gap-2" role="img" aria-label="REASON">
      <img
        src="/reason-mark-small.png"
        alt=""
        className={phone ? 'h-[26px] w-[34px] shrink-0 object-contain' : 'h-[30px] w-[40px] shrink-0 object-contain'}
      />
      <strong
        className={cn(
          'font-extrabold leading-none tracking-[-0.04em]',
          phone ? 'text-[19px]' : 'text-[24px]',
          variant === 'rail' ? 'hidden min-[981px]:block' : 'block',
        )}
      >
        REASON
      </strong>
    </span>
  );
}
