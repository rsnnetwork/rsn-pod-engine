// The address the admin join-request screens open for a request's LinkedIn, or null when there is nothing to open.
//
// LinkedIn is optional on the request form (21 Oct 2026), so a request can hold NULL, and older rows can hold an
// empty string. Those show the plain text "No LinkedIn", never a link that goes nowhere. Only an http(s) address
// is ever handed to an <a href>: the request form used to accept any text that parsed as a URL, so whatever an
// old row holds, it can never be a "javascript:" link in an admin's browser.
//
// Pure on purpose, so a test can run it: server/src/__tests__/client/join-form-linkedin.test.ts.

export function linkedinHref(stored: string | null | undefined): string | null {
  const address = stored?.trim();
  return address && /^https?:\/\//i.test(address) ? address : null;
}
