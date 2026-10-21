// ─── Addresses no person can have (21 Oct 2026) ──────────────────────────────
//
// example.com, example.net and example.org, and every domain under .test, .example, .invalid and
// .localhost, are reserved for documentation and testing (RFC 2606, RFC 6761), so no mailbox there
// can belong to a person. Production end-to-end runs sign members up on them
// (e2etest-…@example.com, …@rsn-e2e.invalid, loadtest_…@rsn-test.invalid) and delete them minutes
// later, so nothing should ever be announced to real members about such an account.

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TOP_LEVEL = ['test', 'example', 'invalid', 'localhost'];

/** True when `email` is on a reserved domain (or one of its subdomains). */
export function isReservedTestAddress(email: string | null | undefined): boolean {
  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).replace(/\.$/, '');
  if (!domain) return false;
  if (RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))) return true;
  return RESERVED_TOP_LEVEL.includes(domain.slice(domain.lastIndexOf('.') + 1));
}
