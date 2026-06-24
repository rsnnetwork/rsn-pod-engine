// ─── Onboarding: known / inferred profile (v1.1) ─────────────────────────────
//
// Uses what we already have before asking: name + email from the account,
// country from an IP geo header (if the edge provides one), company from the
// email domain (skip generic providers). Everything inferred is a *guess to
// confirm*, never asserted as fact.

import { Request } from 'express';
import { query } from '../../db';
import { OnboardingKnownProfile } from '@rsn/shared';

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me',
  'protonmail.com', 'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'pm.me', 'hey.com', 'fastmail.com', 'tutanota.com',
]);

/** Read a 2-letter country code from common edge geo headers and resolve a name. */
export function countryFromHeaders(req: Request): string | null {
  const h = req.headers;
  const raw =
    h['cf-ipcountry'] ||
    h['x-vercel-ip-country'] ||
    h['x-country-code'] ||
    h['x-geo-country'] ||
    h['x-appengine-country'];
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (!code || typeof code !== 'string') return null;
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === 'XX' || cc === 'T1') return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(cc);
    return name && name !== cc ? name : null;
  } catch {
    return null;
  }
}

/**
 * Derive a presentable name from an email local part, for magic-link signups
 * that have no saved name yet (a guess to confirm). e.g. "stefan.avivson@x.com"
 * -> "Stefan Avivson"; "waseemjaved069123@x.com" -> "Waseemjaved".
 */
export function nameFromEmail(email: string): string | null {
  const at = email.indexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at).replace(/\d+$/, ''); // drop trailing digits
  const parts = local.split(/[._\-+]+/).filter(Boolean);
  if (!parts.length) return null;
  const titled = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ').trim();
  return titled || null;
}

/** Infer a company name from a non-generic email domain (a guess to confirm). */
export function companyFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) return null;
  const label = domain.split('.')[0];
  if (!label || label.length < 2) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Build the known/inferred profile for the confirm-known card. Prefers saved
 * values; marks a field `guessed` only when we inferred it (so the UI can show
 * "is this right?" rather than asserting).
 */
export async function inferKnownProfile(req: Request, userId: string): Promise<OnboardingKnownProfile> {
  const r = await query<{
    email: string;
    display_name: string | null;
    first_name: string | null;
    company: string | null;
    location: string | null;
  }>('SELECT email, display_name, first_name, company, location FROM users WHERE id = $1', [userId]);
  const u = r.rows[0];
  const email = (u?.email || req.user?.email || '').trim();

  const savedCompany = u?.company?.trim() || '';
  const guessedCompany = savedCompany ? null : companyFromEmail(email);
  const savedCountry = u?.location?.trim() || '';
  const guessedCountry = savedCountry ? null : countryFromHeaders(req);

  const savedName = (u?.display_name || '').trim();
  const guessedName = savedName ? null : nameFromEmail(email);
  const effectiveName = savedName || guessedName || null;
  const firstName =
    (u?.first_name?.trim() || '') ||
    (effectiveName ? effectiveName.split(/\s+/)[0] : '');

  return {
    name: effectiveName,
    firstName: firstName || null,
    nameGuessed: !savedName && !!guessedName,
    email,
    country: savedCountry || guessedCountry || null,
    countryGuessed: !savedCountry && !!guessedCountry,
    company: savedCompany || guessedCompany || null,
    companyGuessed: !savedCompany && !!guessedCompany,
  };
}
