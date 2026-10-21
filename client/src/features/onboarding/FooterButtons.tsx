// The footer of a screen: [Back] or [Cancel] on the left, the one thing to do
// next on the right, as the brief draws it ("[Back] [Continue]"). On a phone
// the main button takes the rest of the row; both are at least 48px tall.

import { Button } from '@/components/ui/Button';

interface Action {
  label: string;
  onClick: () => void;
}

export interface FooterProps {
  back?: Action;
  primary: Action & {
    /**
     * Not ready yet (a question with nothing ticked): it looks and reads as unavailable, but a press still
     * reaches onClick, which says why. A truly disabled button does nothing on a phone, and says nothing.
     */
    unready?: boolean;
    busy?: boolean;
  };
}

export default function FooterButtons({ back, primary }: FooterProps) {
  return (
    <>
      {back && (
        <Button variant="outline" onClick={back.onClick} className="min-h-[48px] shrink-0 bg-white px-5">
          {back.label}
        </Button>
      )}
      <Button
        onClick={primary.onClick}
        aria-disabled={primary.unready || undefined}
        isLoading={primary.busy}
        className={`min-h-[48px] flex-1 px-6 sm:flex-none sm:min-w-[180px] ${primary.unready ? 'opacity-50' : ''}`}
      >
        {primary.label}
      </Button>
    </>
  );
}
