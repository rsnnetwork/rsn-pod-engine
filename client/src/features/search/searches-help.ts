// The one line on Find people about "your searches" (Shirley pilot S7, item 21: Shirley did not know what the searches
// REASON made for her at sign-up were). Pure, so the server's jest runs it: server/src/__tests__/client/s7-client.test.ts.
// One word for them everywhere a member reads it: "searches" (the People tab, their page, their bell).
// Fix round 1: every sentence is true whatever the member's searches are: some made by onboarding, some by hand, all
// paused, or none at all. The list does not say which searches onboarding made, so no sentence claims a given one did.

export interface SearchSummary { status: 'active' | 'paused' | 'archived' }

export interface SearchesHelpCopy { text: string; link: string }

/**
 * What the line says. While the member's searches are still loading (undefined): what searches are, in general. None
 * open (onboarding skipped, or all archived): set one up. All paused: they are paused, resume one. Some looking: they
 * keep looking, and a paused one is mentioned only when there is one.
 */
export function searchesHelp(searches: readonly SearchSummary[] | undefined): SearchesHelpCopy {
  if (searches === undefined) {
    return {
      text: 'Searches keep looking for the people you want to meet as they join REASON, which sets some up from your onboarding answers.',
      link: 'See your searches',
    };
  }
  const open = searches.filter((s) => s.status !== 'archived');
  if (open.length === 0) {
    return { text: 'Set up a search and REASON keeps looking for the people you want to meet as they join.', link: 'Set up a search' };
  }
  const paused = open.filter((s) => s.status === 'paused').length;
  if (paused === open.length) {
    return {
      text: `Your ${open.length === 1 ? 'search is' : 'searches are'} paused. Resume one and it keeps looking as people join.`,
      link: 'See your searches',
    };
  }
  return {
    text: `Your searches keep looking as people join. REASON sets some up from your onboarding answers, and you can add, edit or pause any of them.${paused > 0 ? ' A paused one starts again when you resume it.' : ''}`,
    link: 'See or edit your searches',
  };
}
