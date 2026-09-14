# What ScrapingDog gives us for a LinkedIn profile (14 Sep 2026)

Live scrapes of an ordinary member (Shradha, `shradhadhikari`) and a famous one
(Satya Nadella, `satyanadella`) through `https://api.scrapingdog.com/linkedin/?type=profile`.
"Ordinary" and "famous" matter: LinkedIn serves a slimmer logged-out page for
ordinary members to proxy traffic, and no ScrapingDog mode (premium, private,
the newer `/profile` endpoint) changes that. Ali's own profile and Stefan's
come back in the ordinary shape.

| Attribute | Shape | Ordinary member | Famous profile | Used by RSN |
|---|---|---|---|---|
| `fullName`, `first_name`, `last_name` | string | yes | yes | name |
| `public_identifier`, `linkedin_internal_id` | string | yes | yes | identity check |
| `profile_photo` | URL | yes | yes | avatar at login |
| `background_cover_image_url` | URL | yes | yes | no |
| `headline` | string | **empty** | yes | role (when present) |
| `location` | string | yes (country) | yes (city) | location |
| `followers`, `connections` | string | yes | yes | highlights |
| `about` | string | **collapsed preview only** (~85 chars, ends "…") | preview only | About, role from own words |
| `experience[]` | position, company_name, company_url, location, summary, starts_at, ends_at, duration | company names only; **position empty**, dates empty, later entries masked `*** ***` | full | current company, past roles |
| `education[]` | college_name, college_url, college_degree, college_degree_field, college_duration, college_activity, starts_at, ends_at | dates only, college masked | full | education lines |
| `certification[]` | certification, company_name (issuer), issue_date, credential_id, credential_url | yes | (none on his) | expertise, highlights |
| `volunteering[]` | company_position, company_name, company_duration, starts_at, ends_at | yes | (none) | highlights |
| `publications[]` | name, sub_title (publisher), summary, date, link | yes, with full summary | (none) | highlights |
| `recommendations[]` | name, link, summary (full text) | yes, full text of each | (none) | highlights, extraction (others' words) |
| `languages[]`, `projects[]`, `awards[]`, `courses[]`, `organizations[]` | name-like objects | empty on hers | empty on his | mapped when present |
| `articles[]` | link, image, title, author, published_date | empty | yes | posts (when present) |
| `activities[]` | link, image, title, activity | **empty** | yes (24) | posts (when present) |
| `description` | `{description1, description1_link, …}` top-card lines | live scrape only | yes | company fallback |
| `people_also_viewed[]`, `similar_profiles[]` | other people | yes | yes | no (not about the member) |
| `score` | array | empty | empty | no |

## What this means for the role

The headline and every job title are missing for ordinary members, in every
mode, and the About is the collapsed preview, so a role stated further down
the About never reaches us. ScrapingDog's own parser returns the full text
for recommendations (both the collapsed and the expanded copy appear in the
payload), which shows the logged-out page does carry expanded text under
"show more"; the same is very likely true of the About, and that is the ask
for ScrapingDog support: return the full `about`, and offer a logged-in
scrape for headline and titles.

## Freshness

ScrapingDog keys its cache on the exact `linkId` text. LinkedIn slugs are
case-insensitive, so the provider scrambles the letter casing per request
and gets a live scrape (10 to 60 seconds) instead of a cached copy (one
second, however old). The cached copy is read only to fill gaps the live page
left (masked entries, missing headline/About).
