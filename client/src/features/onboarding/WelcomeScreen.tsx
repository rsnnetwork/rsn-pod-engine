// Screen 1 of the brief, word for word, with its one button.

import OnboardingShell from './OnboardingShell';
import FooterButtons from './FooterButtons';
import { WELCOME } from './flow';

export default function WelcomeScreen({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <OnboardingShell
      pose="wave"
      title={WELCOME.title}
      footer={<FooterButtons primary={{ label: WELCOME.button, onClick: onStart, busy }} />}
    >
      <div className="mx-auto max-w-md space-y-3 text-center">
        <p className="text-lg font-semibold leading-snug">{WELCOME.lead}</p>
        {WELCOME.lines.map(line => (
          <p key={line} className="text-[15px] leading-relaxed text-gray-600">{line}</p>
        ))}
      </div>
    </OnboardingShell>
  );
}
