// ─── L1 (25 Oct feedback, production's own client): the tour puts its words first and labels its examples ──
//
// Stefan and Claus tested app.rsn.network on 25 Oct. Each tour card showed the picture first, then the heading and
// its words, and the pictures showed "Amara Okafor", "Tomas Lind" and "Priya Raman" with nothing saying they were
// made up. What they asked for (ONB-04, ONB-05): on every card the heading and its explanation come first, then a
// line saying the examples are not real members, then the picture; and every person in a picture is one of the
// made-up English people in shared EXAMPLE_PEOPLE, tagged "Example", with the sheep where their photo would be.
//
// HowRsnWorks.tsx is run here, not only read: its own TOUR_CARDS and TourSlide are drawn to markup, so the order and
// the labels are what a person would get, with only the pieces that need a browser (the animation library, the icon
// set, the button, the sheep) stood in for. What it looks like is measured in e2e/tests/onboarding-tour.spec.ts.

import { createElement, Fragment, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXAMPLE_PEOPLE } from '@rsn/shared';
import { loadClientModule, readClientSource, iconStandIns } from './load-client-module';

const TOUR = 'features/onboarding/HowRsnWorks.tsx';
const source = () => readClientSource(TOUR);

const CAPTION = 'Examples only. These are not real members.';
const OLD_PEOPLE = ['Amara Okafor', 'Tomas Lind', 'Priya Raman', 'Okafor', 'Northwind', 'Baltic Seed'];

interface Card { title: string; body: string; visual: ReactElement }

// The sheep draws the file it would show, so the pictures can be read as well as the words.
const SheepStandIn = ({ pose }: { pose: string }) => createElement('img', { src: `/sheep/${pose}.png`, alt: '', 'data-pose': pose });

function loadTour(): { TOUR_CARDS: Card[]; TourSlide?: (props: { card: Card }) => ReactElement } {
  return loadClientModule(TOUR, {
    'framer-motion': { motion: { div: 'div' }, AnimatePresence: Fragment, useReducedMotion: () => true },
    'lucide-react': iconStandIns,
    '@/components/ui/Button': { Button: () => null },
    '@/components/brand/SheepAvatar': { __esModule: true, default: SheepStandIn },
  }) as never;
}

/** What a person reads in some markup: its tags taken out, one text node per entry. */
const words = (html: string): string[] => html.replace(/<[^>]*>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
/** React writes an apostrophe as &#x27; and an ampersand as &amp;. */
const asMarkup = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
/** The picture's own markup: from its opening tag on. */
const pictureOf = (slide: string): string => slide.slice(slide.indexOf('data-testid="tour-picture"'));

describe('L1 - the tour on production: words first, then a caption, then a labelled picture', () => {
  // Built on first use, inside a test, so a missing piece fails that test with a message rather than the whole file.
  let built: { cards: Card[]; slides: Array<{ card: Card; html: string }> } | undefined;
  const tour = () => {
    if (!built) {
      const { TOUR_CARDS, TourSlide } = loadTour();
      expect(typeof TourSlide).toBe('function');
      built = {
        cards: TOUR_CARDS,
        slides: TOUR_CARDS.map((card) => ({ card, html: renderToStaticMarkup(createElement(TourSlide!, { card })) })),
      };
    }
    return built;
  };

  it('there are still the four cards, with production\'s own words (Suggestions, I want to meet)', () => {
    const { cards } = tour();
    expect(cards.map((c) => c.title)).toEqual(['Suggestions', 'Matches', 'Meetings', 'Circles & events']);
    expect(cards[0].body).toBe("We suggest people who match your intent. Tap 'I want to meet' to ask.");
    expect(words(renderToStaticMarkup(cards[0].visual))).toContain('I want to meet');
  });

  it('on every card the heading comes first, then its explanation, then the caption, then the picture', () => {
    for (const { card, html } of tour().slides) {
      const at = {
        heading: html.search(/<h2[ >]/),
        body: html.indexOf(asMarkup(card.body)),
        caption: html.indexOf(CAPTION),
        picture: html.indexOf('data-testid="tour-picture"'),
      };
      expect(Object.values(at).every((i) => i >= 0)).toBe(true);
      expect(at.heading).toBeLessThan(at.body);
      expect(at.body).toBeLessThan(at.caption);
      expect(at.caption).toBeLessThan(at.picture);
      // The first thing a slide says is its own title.
      expect(words(html)[0]).toBe(asMarkup(card.title));
    }
  });

  it('the caption says the examples are not real members, and sits outside the hidden picture so a screen reader reads it', () => {
    for (const { html } of tour().slides) {
      expect(html).toContain(CAPTION);
      const opening = html.match(/<[^>]*data-testid="tour-picture"[^>]*>/)![0];
      expect(opening).toContain('aria-hidden="true"');
      expect(pictureOf(html)).not.toContain(CAPTION);
    }
  });

  it('the tour draws no sheep of its own above the heading: the sheep is in the pictures, where a photo would be', () => {
    const src = source();
    const dialog = src.slice(src.indexOf('return createPortal('), src.indexOf('// ── The pictures.'));
    expect(dialog).toContain('<TourSlide card={TOUR_CARDS[index]} />');
    expect(dialog).not.toMatch(/SheepAvatar|<img/);
    const [suggestions, matches] = tour().cards.map((c) => renderToStaticMarkup(c.visual));
    expect(suggestions).toContain('/sheep/');
    expect(matches).toContain('/sheep/');
  });

  it('nobody from before is in a picture: no Amara, Tomas or Priya and no company names, in the file or in the markup', () => {
    const src = source();
    for (const old of OLD_PEOPLE) {
      expect(src).not.toContain(old);
      for (const { html } of tour().slides) expect(html).not.toContain(old);
    }
  });

  it('every person in a picture comes from EXAMPLE_PEOPLE, by name and role, never typed into the file', () => {
    const src = source();
    expect(src).toMatch(/import \{[^}]*\bEXAMPLE_PEOPLE\b[^}]*\} from '@rsn\/shared'/);
    for (const person of EXAMPLE_PEOPLE) {
      expect(src).not.toContain(person.name);
      // A role typed as a word of its own ('Founder', not the circle called Founders).
      expect(src).not.toMatch(new RegExp(`['">]${person.role}['"<]`));
    }
    const { slides } = tour();
    const suggestions = words(pictureOf(slides[0].html));
    for (const person of EXAMPLE_PEOPLE.slice(0, 2)) {
      expect(suggestions).toContain(person.name);
      expect(suggestions).toContain(person.role);
    }
    const matches = words(pictureOf(slides[1].html));
    for (const person of EXAMPLE_PEOPLE.slice(0, 3)) expect(matches).toContain(person.name);
  });

  it('each person card in Suggestions carries the tag "Example", and each list picture carries one for the whole frame', () => {
    const tags = tour().slides.map(({ html }) => words(pictureOf(html)).filter((w) => w === 'Example').length);
    // Two people, one tag on each. Matches, Meetings and Circles: one tag on the frame, so the rows are not crowded.
    expect(tags).toEqual([2, 1, 1, 1]);
  });

  it('every person is the sheep where a photo would be, so none can pass for a real member', () => {
    const { slides } = tour();
    expect(pictureOf(slides[0].html).match(/<img /g)).toHaveLength(2);
    expect(pictureOf(slides[1].html).match(/<img /g)).toHaveLength(3);
    expect(source()).not.toMatch(/ui\/Avatar/);
  });

  it('the pictures are hidden from a screen reader, and the example tag is text, not colour alone', () => {
    const src = source();
    // A function's text, from its first line to the closing brace that starts a line.
    const bodyOf = (signature: string): string => {
      const from = src.indexOf(signature);
      expect(from).toBeGreaterThanOrEqual(0);
      return src.slice(from, src.indexOf('\n}', from));
    };
    expect(bodyOf('function Frame(')).toMatch(/aria-hidden/);
    expect(bodyOf('function ExampleTag(')).toMatch(/>Example</);
  });
});
