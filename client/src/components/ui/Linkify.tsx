// Render plain user text with bare URLs turned into real links.
//
// 30 Jul 2026: circle posts and comments rendered URLs as dead text, so a
// shared Luma link could not be opened. Two near-identical local copies of this
// already existed in the live-event components; this is the single version they
// should all use.
//
// Security: this never injects HTML. The text is split and re-rendered as React
// nodes, so it stays escaped exactly as before, and only http/https survives the
// match (no javascript:, no data:). Links open in a new tab with noopener.

const URL_PATTERN = /(https?:\/\/[^\s<>"')\]]+)/g;
const IS_URL = /^https?:\/\//i;
// A URL at the end of a sentence swallows the punctuation: "see https://x.com."
// Trim the trailing characters that are far more likely prose than path.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export default function Linkify({ text, className }: { text: string; className?: string }) {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, i) => {
        if (!IS_URL.test(part)) return <span key={i}>{part}</span>;
        const trailing = part.match(TRAILING_PUNCTUATION)?.[0] ?? '';
        const href = trailing ? part.slice(0, -trailing.length) : part;
        return (
          <span key={i}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={className ?? 'break-all text-rsn-red underline hover:opacity-80'}
            >
              {href}
            </a>
            {trailing}
          </span>
        );
      })}
    </>
  );
}
