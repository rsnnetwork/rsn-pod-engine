// ─── Want synonym expansion (W4, 7 Sep 2026) ────────────────────────────────
//
// "Search is too dependent on exact keywords; we could not find people we knew
// should match." The scorer is deliberately AI-free (June-19: "no AI required,
// just matching"), and the 7 Sep budget rule (keep prod LLM spend under
// $10/month) argues against a per-agent model call. So relatedness is a small,
// curated, HIGH-CONFIDENCE synonym map applied once when an agent is created:
// the extra terms are stored in matching_agents.matching_tags, which the scorer
// already reads, so "AI" also matches "machine learning" without any spend.
//
// Kept conservative on purpose — a wrong synonym costs precision. Add clusters
// only when a real miss justifies it. Each cluster is bidirectional: matching
// ANY term in it contributes ALL of its terms.

const CLUSTERS: string[][] = [
  ['ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning'],
  ['ml engineer', 'mlops', 'machine learning engineer'],
  ['fintech', 'financial technology', 'payments', 'banking technology'],
  ['developer', 'engineer', 'software engineer', 'programmer', 'software developer'],
  ['designer', 'ux', 'ui', 'product designer', 'ux designer'],
  ['founder', 'co-founder', 'cofounder', 'entrepreneur', 'business owner'],
  ['investor', 'vc', 'venture capital', 'angel investor', 'angel'],
  ['marketing', 'growth', 'demand generation', 'brand', 'marketer'],
  ['sales', 'business development', 'bizdev', 'account executive', 'sdr'],
  ['recruiter', 'talent', 'hr', 'people ops', 'human resources', 'talent acquisition'],
  ['manufacturing', 'manufacturer', 'manufacturers', 'production', 'factory', 'industrial', 'fabrication', 'industrial fabrication', 'machining', 'assembly'],
  ['supply chain', 'logistics', 'procurement', 'sourcing'],
  ['hardware', 'electronics', 'iot', 'embedded'],
  ['construction', 'building', 'contractor', 'engineering firm'],
  ['agency', 'studio', 'consultancy'],
  ['cto', 'chief technology officer', 'head of engineering', 'vp engineering'],
  ['ceo', 'chief executive', 'managing director', 'md'],
  ['healthcare', 'health', 'medtech', 'medical', 'health tech'],
  ['ecommerce', 'e-commerce', 'online retail', 'dtc', 'direct to consumer'],
  ['saas', 'software as a service', 'b2b software', 'cloud software'],
  ['data', 'data science', 'analytics', 'data engineer', 'data analyst'],
  ['product manager', 'pm', 'product management', 'product lead'],
  ['operations', 'ops', 'coo', 'operator'],
  ['consultant', 'consulting', 'advisor', 'advisory'],
  ['coach', 'coaching', 'mentor', 'mentoring'],
  ['real estate', 'property', 'proptech'],
];

// term → set of related terms (built once).
const INDEX = new Map<string, Set<string>>();
for (const cluster of CLUSTERS) {
  for (const term of cluster) {
    const rel = INDEX.get(term) ?? new Set<string>();
    for (const other of cluster) rel.add(other);
    INDEX.set(term, rel);
  }
}

/**
 * Given the terms an agent already carries (its structured tags / designations
 * / industries), return that set UNION any high-confidence synonyms — deduped,
 * lowercase, order-stable. A term contributes its cluster only on a whole-term
 * or clear substring hit, so "ai" in "email" never triggers ("ai" is matched as
 * a standalone token, not a substring).
 */
export function expandWantTags(terms: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const v = t.trim().toLowerCase();
    if (v.length < 2 || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  for (const raw of terms) {
    const term = (raw || '').trim().toLowerCase();
    if (!term) continue;
    push(term);
    // Direct cluster hit on the whole term.
    const direct = INDEX.get(term);
    if (direct) { for (const r of direct) push(r); continue; }
    // Otherwise, look for any cluster KEY that appears as a whole word inside a
    // multi-word term ("senior ml engineer" → ml engineer cluster).
    for (const [key, rel] of INDEX) {
      if (key.includes(' ') && term.includes(key)) { for (const r of rel) push(r); }
      else if (!key.includes(' ') && new RegExp(`(^|\\W)${escapeRe(key)}(\\W|$)`).test(term)) { for (const r of rel) push(r); }
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
