/**
 * ScrapingDog Discovery Script
 *
 * Purpose: Discover and record the real LinkedIn profile data shape via the
 * ScrapingDog API, generating a fixture for use in profile enrichment tests.
 * The recorded fixture MUST have all sensitive data (personal details, emails,
 * phone numbers, private URLs) stripped before committing to the repository.
 *
 * The committed fixture (server/src/__tests__/fixtures/scrapingdog-profile.json)
 * was captured live on 2026-07-24 against Ali Hamza's own public profile.
 *
 * Usage: node e2e/scrapingdog-discover.mjs <linkedin-url-or-slug>
 * Example: node e2e/scrapingdog-discover.mjs /in/alihamza143
 *
 * Environment:
 * - Reads SCRAPINGDOG_API_KEY from process.env if set
 * - Otherwise, parses server/.env for the line SCRAPINGDOG_API_KEY=...
 * - Exits with a friendly message if the key is not found
 *
 * API notes from the live A2 discovery call (2026-07-24):
 * - `private=true` returns a hard HTTP 400 ("Try again or use premium=true").
 *   The working parameter is `premium=true` (this script now sends it).
 * - A quota/plan problem arrives as a JSON body `{"success":false,"message":
 *   "..."}`, which can show up under a 200 OR a 400 status — it is NOT the
 *   same thing as "no such profile" and is reported distinctly below.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENV_PATH = path.join(PROJECT_ROOT, 'server', '.env');
const FIXTURE_DIR = path.join(PROJECT_ROOT, 'server', 'src', '__tests__', 'fixtures');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'scrapingdog-profile.json');

const API_ENDPOINT = 'https://api.scrapingdog.com/linkedin/';
const MAX_RETRIES = 6;
const RETRY_DELAY_MS = 20000;

/**
 * Parse server/.env for SCRAPINGDOG_API_KEY
 * Simple line parser: reads the file, finds SCRAPINGDOG_API_KEY=value, returns value
 */
function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('SCRAPINGDOG_API_KEY=')) {
        const value = trimmed.substring('SCRAPINGDOG_API_KEY='.length).trim();
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          return value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    // File doesn't exist or can't be read; that's OK
  }
  return null;
}

/**
 * Get the API key from env or .env file
 */
function getApiKey() {
  if (process.env.SCRAPINGDOG_API_KEY) {
    return process.env.SCRAPINGDOG_API_KEY;
  }
  const fromFile = parseEnvFile(SERVER_ENV_PATH);
  if (fromFile) {
    return fromFile;
  }
  return null;
}

/**
 * Extract slug from a LinkedIn URL or return the slug as-is
 * Handles:
 * - https://www.linkedin.com/in/slug/
 * - https://www.linkedin.com/in/slug?param=value
 * - /in/slug
 * - slug (bare)
 */
function extractSlug(urlOrSlug) {
  let slug = urlOrSlug.trim();

  // If it looks like a URL, extract the slug
  if (slug.includes('linkedin.com') || slug.startsWith('/')) {
    // Match /in/<slug> with optional query params and trailing slash
    const match = slug.match(/\/in\/([^/?]+)/);
    if (match) {
      slug = match[1];
    }
  }

  return slug;
}

/**
 * Check field presence in the profile object
 */
function fieldPresenceSummary(profile) {
  const fields = [
    'fullName',
    'first_name',
    'last_name',
    'headline',
    'profile_photo',
    'profile_pic_url',
    'location',
    'about',
    'experience',
    'education'
  ];

  console.log('\n--- Field Presence Summary ---');
  for (const field of fields) {
    const value = profile[field];
    if (field === 'experience') {
      // Check if experience array exists and has items
      if (Array.isArray(value) && value.length > 0) {
        const exp = value[0];
        const positionPresent = exp && exp.position ? 'PRESENT' : 'MISSING';
        const companyPresent = exp && exp.company_name ? 'PRESENT' : 'MISSING';
        console.log(`  experience[0].position: ${positionPresent}`);
        console.log(`  experience[0].company_name: ${companyPresent}`);
      } else {
        console.log(`  experience[0].position: MISSING`);
        console.log(`  experience[0].company_name: MISSING`);
      }
    } else if (field === 'education') {
      // Check if education array exists
      if (Array.isArray(value) && value.length > 0) {
        console.log(`  ${field}: PRESENT (${value.length} items)`);
      } else {
        console.log(`  ${field}: MISSING`);
      }
    } else {
      console.log(`  ${field}: ${value ? 'PRESENT' : 'MISSING'}`);
    }
  }
  console.log('');
}

/**
 * Make request to ScrapingDog API with retry logic for 202
 */
async function fetchProfile(apiKey, slug, attemptNum = 1) {
  // Build URL without exposing the key in logs
  const url = new URL(API_ENDPOINT);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('type', 'profile');
  url.searchParams.set('linkId', slug);
  url.searchParams.set('premium', 'true');

  try {
    const response = await fetch(url.toString());
    const status = response.status;
    const body = await response.text();

    if (status === 202) {
      console.log(`[Attempt ${attemptNum}/${MAX_RETRIES}] 202 Accepted — still scraping, retrying in 20s...`);
      if (attemptNum < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        return fetchProfile(apiKey, slug, attemptNum + 1);
      } else {
        console.error(`Failed: max retries (${MAX_RETRIES}) exceeded. Last status: 202`);
        process.exit(1);
      }
    }

    // A `{"success":false,"message":"..."}` body is ScrapingDog's own signal
    // for a request/plan problem — can arrive under a 200 OR a 400 status.
    // Distinguish a quota block (out of credits — fix the plan, not the URL)
    // from any other success:false message, and report clearly either way.
    let parsedBody;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = undefined;
    }
    if (parsedBody && !Array.isArray(parsedBody) && typeof parsedBody === 'object' && parsedBody.success === false) {
      const message = typeof parsedBody.message === 'string' ? parsedBody.message : '(no message)';
      const isQuota = /free pack|upgrade|quota/i.test(message);
      console.error(`\n${isQuota ? 'QUOTA/PLAN LIMIT' : 'PROVIDER ERROR'} (HTTP ${status}, success:false):`);
      console.error(`  ${message}`);
      process.exit(1);
    }

    if (status === 200) {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        console.error(`Error: status 200 but response is not valid JSON`);
        console.error(`Response body: ${body.slice(0, 500)}`);
        process.exit(1);
      }

      console.log('\n✓ 200 OK - Profile data received\n');
      console.log('--- Full JSON Response ---');
      console.log(JSON.stringify(json, null, 2));

      // Write fixture file
      if (!fs.existsSync(FIXTURE_DIR)) {
        fs.mkdirSync(FIXTURE_DIR, { recursive: true });
        console.log(`\n✓ Created directory: ${FIXTURE_DIR}`);
      }

      fs.writeFileSync(FIXTURE_PATH, JSON.stringify(json, null, 2));
      console.log(`✓ Fixture saved to: ${FIXTURE_PATH}`);
      console.log('  IMPORTANT: Strip sensitive data before committing (emails, phone, private URLs)\n');

      fieldPresenceSummary(json);
      return json;
    }

    if ([404, 410].includes(status)) {
      console.error(`\nError: HTTP ${status} (profile genuinely unretrievable)`);
      console.error(`Response: ${body.slice(0, 500)}`);
      process.exit(1);
    }

    console.error(`\nUnexpected status: HTTP ${status}`);
    console.error(`Response: ${body.slice(0, 500)}`);
    process.exit(1);
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  // Validate arguments
  if (process.argv.length < 3) {
    console.error('Usage: node e2e/scrapingdog-discover.mjs <linkedin-url-or-slug>');
    console.error('Example: node e2e/scrapingdog-discover.mjs /in/alihamza143');
    process.exit(1);
  }

  const urlOrSlug = process.argv[2];

  // Get API key
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('Error: SCRAPINGDOG_API_KEY not found.');
    console.error('Set it in process.env.SCRAPINGDOG_API_KEY or add to server/.env:');
    console.error('  SCRAPINGDOG_API_KEY=your_api_key_here');
    process.exit(1);
  }

  // Extract slug
  const slug = extractSlug(urlOrSlug);
  if (!slug) {
    console.error(`Error: could not extract LinkedIn slug from: ${urlOrSlug}`);
    process.exit(1);
  }

  console.log(`ScrapingDog Profile Discovery`);
  console.log(`LinkedIn slug: ${slug}`);
  console.log(`API endpoint: ${API_ENDPOINT}`);
  console.log(`Max retries: ${MAX_RETRIES} (20s between attempts)\n`);

  // Fetch profile
  await fetchProfile(apiKey, slug);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
