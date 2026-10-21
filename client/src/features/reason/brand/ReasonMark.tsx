import { cn } from '@/lib/utils';

// The official sheep with its outline grown outward (reason-mark-small.png), so its white face still reads at
// 26 to 40px, and the REASON wordmark beside it: one line, the two centred on each other. "rail" hides the
// words at 721–980px.
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
