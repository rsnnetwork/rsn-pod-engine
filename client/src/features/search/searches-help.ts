// The one line on Find people about "your searches" (Shirley pilot S7, item 21: Shirley did not know what the searches
// REASON made for her at sign-up were). Pure, so the server's jest runs it: server/src/__tests__/client/s7-search-help.test.ts.
// One word for them everywhere a member reads it: "searches" (the People tab, their page, their bell).

export interface SearchSummary { status: 'active' | 'paused' | 'archived' }

export interface SearchesHelpCopy { text: string; link: string }

/**
 * What the line says. While the member's searches are still loading (undefined) it says the general line. With none
 * (onboarding skipped, or all archived) it offers to set one up; with a paused one it says how to start it again.
 */
export function searchesHelp(searches: readonly SearchSummary[] | undefined): SearchesHelpCopy {
  const open = (searches ?? []).filter((s) => s.status !== 'archived');
  if (searches && open.length === 0) {
    return { text: 'Set up a search and REASON keeps looking for the people you want to meet as they join.', link: 'Set up a search' };
  }
  const paused = open.some((s) => s.status === 'paused');
  return {
    text: `When you joined, REASON set up searches from your answers. They keep looking as people join${paused ? '; a paused one starts again when you resume it' : ''}.`,
    link: 'See or edit your searches',
  };
}
