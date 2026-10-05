import { cn } from '@/lib/utils';

// The official sheep mark (pixel-identical to Stefan's OFFICIAL_LOGO_REFERENCE)
// with the REASON wordmark. "rail" hides the words at 721–980px.
export default function ReasonMark({ variant = 'full' }: { variant?: 'full' | 'rail' | 'mobile' }) {
  return (
    <span className="flex min-w-0 items-center gap-2" role="img" aria-label="REASON">
      <img
        src="/rsn-sheep.png"
        alt=""
        className={variant === 'mobile' ? 'h-[26px] w-[34px] shrink-0 object-contain' : 'h-[30px] w-[40px] shrink-0 object-contain'}
      />
      <span className={cn('items-end gap-1', variant === 'rail' ? 'hidden min-[981px]:flex' : 'flex')}>
        <strong className={cn('font-extrabold leading-none tracking-[-0.04em]', variant === 'mobile' ? 'text-[19px]' : 'text-[24px]')}>
          REASON
        </strong>
        {variant !== 'mobile' && <small className="mb-0.5 text-[10px] tracking-[0.12em] text-reason-muted">RSN</small>}
      </span>
    </span>
  );
}
