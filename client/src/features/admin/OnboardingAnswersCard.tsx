// ─── Admin inspector: "Onboarding answers" (30 Oct review, 2.3; L4) ─────────
//
// "Onboarding answers should be saved and visible in the admin report." The member's answers as they gave them: which
// onboarding they did, the four questions with the labels they ticked (from the shared catalogue, never a key), their
// own words in quotes, the specific wish, where they are based and their time zone. Someone who did only the earlier
// onboarding shows its keys raw under "Earlier answers", never a guessed mapping. The button downloads every active
// member's answers as a CSV (each download is written to the audit log on the server).

import { useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import {
  ONBOARDING_V2_COPY, ONBOARDING_V2_FIND, ONBOARDING_V2_MEET, ONBOARDING_V2_OFFER, ONBOARDING_V2_OTHER_KEYS, ONBOARDING_V2_SELF,
  onboardingDone, shortLabelFor, type AdminOnboardingAnswers, type OnboardingOption,
} from '@rsn/shared';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

const NOT_ANSWERED = 'Not answered';

interface Row {
  title: string;
  options: readonly OnboardingOption[];
  keys: readonly string[];
  otherKey: string;
  ownWords: string | null;
}

function rowsOf(a: AdminOnboardingAnswers): Row[] {
  const O = ONBOARDING_V2_OTHER_KEYS;
  const C = ONBOARDING_V2_COPY;
  return [
    { title: C.meet.title, options: ONBOARDING_V2_MEET, keys: a.lookingToMeet, otherKey: O.meet, ownWords: a.meetOther },
    { title: C.find.title, options: ONBOARDING_V2_FIND, keys: a.hopingToFind, otherKey: O.find, ownWords: a.findOther },
    { title: C.offer.title, options: ONBOARDING_V2_OFFER, keys: a.canOffer, otherKey: O.offer, ownWords: a.offerOther },
    { title: C.self.title, options: ONBOARDING_V2_SELF, keys: a.selfKinds, otherKey: O.self, ownWords: a.selfOther },
  ];
}

const BADGE = { 'New onboarding': 'success', 'Earlier onboarding': 'warning', 'Not done': 'default' } as const;

function Answer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="mt-1 text-sm text-gray-800 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const Missing = () => <span className="italic text-gray-400">{NOT_ANSWERED}</span>;

/** Every active member's answers, as the CSV the server makes; the browser saves it. */
function useDownloadCsv() {
  const addToast = useToastStore(s => s.addToast);
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await api.get('/admin/onboarding/export.csv', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `reason-onboarding-answers-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      addToast('We could not make the CSV. Try again in a moment.', 'error');
    } finally {
      setDownloading(false);
    }
  };
  return { download, downloading };
}

export default function OnboardingAnswersCard({ answers, status }: { answers: AdminOnboardingAnswers | undefined; status: string | undefined }) {
  const { download, downloading } = useDownloadCsv();
  const done = onboardingDone(status, answers?.version);

  return (
    <Card className="!p-5" data-testid="onboarding-answers-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-[#1a1a2e]">Onboarding answers</h2>
          <Badge variant={BADGE[done]}>{done}</Badge>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void download()}
          isLoading={downloading}
          className="min-h-[44px] w-full shrink-0 gap-2 sm:w-auto"
        >
          <Download className="h-4 w-4" aria-hidden /> Download onboarding answers (CSV)
        </Button>
      </div>

      {!answers ? (
        <p className="mt-4 text-sm text-gray-500">No answers to show.</p>
      ) : (
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {rowsOf(answers).map(row => {
            const ticked = row.keys.filter(k => k !== row.otherKey);
            const said = row.keys.includes(row.otherKey) ? row.ownWords : null;
            return (
              <Answer key={row.title} label={row.title}>
                {ticked.length || said ? (
                  <ul className="space-y-0.5">
                    {ticked.map(k => <li key={k}>{shortLabelFor(row.options, k)}</li>)}
                    {said && <li>“{said}”</li>}
                  </ul>
                ) : <Missing />}
              </Answer>
            );
          })}
          <Answer label="Anything specific">{answers.findSpecific ? `“${answers.findSpecific}”` : <Missing />}</Answer>
          <Answer label="Where they are based">{answers.location || <Missing />}</Answer>
          <Answer label="Time zone">{answers.timezone || <Missing />}</Answer>
          {answers.version !== 2 && answers.v1Keys.length > 0 && (
            <Answer label="Earlier answers">
              <span className="font-mono text-xs text-gray-600">{answers.v1Keys.join(', ')}</span>
            </Answer>
          )}
        </dl>
      )}
    </Card>
  );
}
