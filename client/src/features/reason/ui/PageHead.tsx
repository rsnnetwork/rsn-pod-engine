import ReasonSheep, { type ReasonSheepPose } from '../brand/ReasonSheep';

interface Props { eyebrow: string; title: string; subtitle: string; pose: ReasonSheepPose }

export default function PageHead({ eyebrow, title, subtitle, pose }: Props) {
  return (
    <header className="mb-[18px] grid grid-cols-[minmax(0,1fr)_68px] items-end gap-2.5 min-[721px]:mb-[22px] min-[721px]:flex min-[721px]:items-start min-[721px]:justify-between min-[721px]:gap-7">
      <div className="min-w-0">
        <p className="text-[9px] font-extrabold uppercase tracking-[0.13em] text-[#7b8190] min-[721px]:text-[11px] min-[721px]:tracking-[0.14em]">{eyebrow}</p>
        <h1 className="mt-1.5 text-[28px] font-extrabold leading-[1.02] tracking-[-0.045em] [overflow-wrap:anywhere] min-[391px]:text-[31px] min-[721px]:mt-[7px] min-[721px]:text-[42px] min-[721px]:leading-none">{title}</h1>
        <p className="mt-[7px] text-[14px] leading-[1.42] text-reason-muted min-[721px]:mt-2 min-[721px]:text-[17px] min-[721px]:leading-[1.45]">{subtitle}</p>
      </div>
      <ReasonSheep pose={pose} className="h-[66px] w-[62px] justify-self-end min-[391px]:h-[72px] min-[391px]:w-[68px] min-[721px]:h-[92px] min-[721px]:w-[116px] min-[721px]:[filter:drop-shadow(0_12px_14px_rgba(0,0,0,.06))]" />
    </header>
  );
}
