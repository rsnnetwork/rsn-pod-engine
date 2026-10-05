import PageHead from '../ui/PageHead';
import ReasonSheep from '../brand/ReasonSheep';

const COPY = {
  entities: {
    eyebrow: 'THE NETWORK AROUND PEOPLE', title: 'Entities matter.',
    subtitle: 'Companies, funds, projects and organisations give relationships context.', pose: 'thinking',
    noteTitle: 'Organisations come next.', note: 'For now each person shows their company on their card and profile.',
  },
  introductions: {
    eyebrow: 'THE HUMAN BRIDGE', title: 'Introductions create leverage.',
    subtitle: 'Make the right introduction at the right time and let REASON learn what happened.', pose: 'hopeful',
    noteTitle: 'Introductions come in a later step.', note: 'Meeting requests you send and receive are in Messages.',
  },
} as const;

export default function ComingSoonPage({ kind }: { kind: keyof typeof COPY }) {
  const c = COPY[kind];
  return (
    <>
      <PageHead eyebrow={c.eyebrow} title={c.title} subtitle={c.subtitle} pose={c.pose} />
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5 min-[721px]:items-center min-[721px]:gap-5 min-[721px]:p-6">
        <ReasonSheep pose="curious" className="h-[58px] w-[58px] shrink-0 min-[721px]:h-[92px] min-[721px]:w-[92px]" />
        <div>
          <h2 className="text-[16px] font-bold">{c.noteTitle}</h2>
          <p className="mt-1 text-[13px] text-reason-muted">{c.note}</p>
        </div>
      </div>
    </>
  );
}
