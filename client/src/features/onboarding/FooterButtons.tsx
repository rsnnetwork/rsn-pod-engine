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
  primary: Action & { disabled?: boolean; busy?: boolean };
}

type Props = FooterProps;

export default function FooterButtons({ back, primary }: Props) {
  return (
    <>
      {back && (
        <Button variant="outline" onClick={back.onClick} className="min-h-[48px] shrink-0 bg-white px-5">
          {back.label}
        </Button>
      )}
      <Button
        onClick={primary.onClick}
        disabled={primary.disabled}
        isLoading={primary.busy}
        className="min-h-[48px] flex-1 px-6 sm:flex-none sm:min-w-[180px]"
      >
        {primary.label}
      </Button>
    </>
  );
}
