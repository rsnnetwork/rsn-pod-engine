// SPIKE — validate the core assumption before building the feature:
// does Claude's web_search tool (from RSN's API key) return useful, structured
// person data we can write into a profile? Tests both a clearly-public person
// and a name+company+city case (the no-LinkedIn path).
import Anthropic from '@anthropic-ai/sdk';
import { config as dc } from 'dotenv';
dc({ path: 'C:/Users/ARFA TECH/Desktop/RSN-dev/server/.env' });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = (who) => `You are enriching a networking profile. Find this person's PUBLIC professional profile via web search and return ONLY a JSON object (no prose) with these keys:
fullName, headline, currentRole, currentCompany, industry, location, summary, pastRoles (array of strings), education (array), skills (array), likelyWantsToMeet (array), likelyOffers (array), linkedinUrl, confidence (0..1 — how sure you are this is the right person), sources (array of urls you used).
Use null or [] for anything you cannot support from search results. Do NOT invent facts. If you cannot find a confident match, set confidence low and explain nothing — just return the JSON.

Person: ${who}`;

async function enrich(label, who, model) {
  console.log(`\n=== ${label} (${model}) ===`);
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 2500,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: PROMPT(who) }],
    });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const searchUses = resp.content.filter((b) => b.type === 'server_tool_use').length;
    console.log('stop_reason:', resp.stop_reason, '| web_search calls:', searchUses);
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { const j = JSON.parse(m[0]); console.log('PARSED JSON:', JSON.stringify(j, null, 1)); }
      catch { console.log('RAW (json parse failed):', text.slice(0, 1200)); }
    } else console.log('NO JSON. text:', text.slice(0, 800));
    console.log('usage:', JSON.stringify(resp.usage));
  } catch (e) {
    console.log('ERROR:', e.status || '', e.message);
  }
}

// 1) clearly-public person — validates the mechanism returns rich data
await enrich('public founder', 'Patrick Collison, co-founder and CEO of Stripe, San Francisco', 'claude-sonnet-4-6');
// 2) name + company (from email domain) + city — the no-LinkedIn path
await enrich('name+company+city', 'Matthew Jones, co-founder of The Cruise Globe, London, UK', 'claude-sonnet-4-6');
// 3) try web search on Haiku (the onboarding model) — basic variant
try {
  console.log('\n=== Haiku basic web_search probe ===');
  const r = await client.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 1500,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: PROMPT('Patrick Collison, CEO of Stripe') }],
  });
  console.log('haiku stop_reason:', r.stop_reason, '| ok (web search works on haiku too)');
} catch (e) { console.log('haiku web_search ERROR:', e.status || '', e.message); }

console.log('\nSPIKE DONE');
