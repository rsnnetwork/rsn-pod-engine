// client/src/features/reason/profile/PublicCardView.tsx
// What a public profile link shows (Shirley pilot S6, D5): the member's banner and their public card in the Human
// Profile's own frame, and what they can bring. Nothing else: no entities, no circles or pods, no Message, Meet or Call.
// Drawn from the server's PublicProfileCard only, on the signed-out page (/p/:token) and in the owner's preview.
import type { PublicProfileCard } from '@rsn/shared';
import ProfileBanner from '../human/ProfileBanner';
import { DarkPanel, HeroFrame, NoteBox, Offer } from '../human/ProfileHero';
import { personFacts } from '../human/profile-text';
import { visibleText } from '../person';

export default function PublicCardView({ card }: { card: PublicProfileCard }) {
  // personFacts reads a member's card; this one has no id, and needs none.
  const who = personFacts({ ...card, id: '' });
  const bring = visibleText(card.canBring);
  return (
    <div className="grid gap-[11px] md:gap-[18px]" data-testid="public-card">
      {card.bannerUrl && <ProfileBanner src={card.bannerUrl} />}
      <HeroFrame
        photo={card.avatarUrl}
        who={who}
        hasBanner={!!card.bannerUrl}
        kicker="On REASON"
        note={<NoteBox title={`${who.first} is on REASON`} line="REASON introduces people who should meet, and explains why." />}
        panel={(
          <DarkPanel kicker="What they can bring" title={bring ? `What ${who.first} can bring.` : `${who.first} has not said yet.`}>
            {bring ? (
              <div className="mt-[18px] grid gap-2.5 md:mt-auto md:pt-[22px]">
                <Offer label="They can bring" text={bring} />
              </div>
            ) : (
              <p className="mt-3.5 text-[14px] leading-relaxed text-[#d4d6da]">When {who.first} says what they can bring, it shows here.</p>
            )}
          </DarkPanel>
        )}
      />
    </div>
  );
}
