// ─── Settings calls a meeting request a meeting request ──────────────────────
// (8 Oct 2026)
//
// The notification table on the Settings page had a row labelled "Pokes", described as "When someone
// you haven't met pokes you". Members never see the word anywhere else: the product says "Meet" and
// "meeting request". The row's key stays 'poke' because it names the preference columns the server
// stores (poke_bell, poke_email); only what the member reads changes.
//
// The client has no test runner of its own, so, like the other files here, this reads the source. The
// table is evaluated from the page's own text, so what is checked is what the page shows.

import * as fs from 'fs';
import * as path from 'path';

const SETTINGS = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/settings/SettingsPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

interface NotificationRow { key: string; label: string; description: string }

/** The page's table of notification rows (Bell / Email toggles), read out of the source and evaluated. */
function notificationRows(source: string): NotificationRow[] {
  const start = source.indexOf('const rows = [');
  if (start < 0) throw new Error('SettingsPage.tsx no longer has "const rows = [": update this test to find the notification table.');
  const end = source.indexOf('\n  ];', start);
  if (end < 0) throw new Error('Found the notification table in SettingsPage.tsx but not where it ends ("\\n  ];").');
  return new Function(`return ${source.slice(start + 'const rows = '.length, end + '\n  ]'.length)}`)() as NotificationRow[];
}

describe('the Settings notification table', () => {
  const rows = notificationRows(SETTINGS);

  it('calls the row for meeting requests "Meeting requests", and says so in words', () => {
    expect(rows.find((r) => r.key === 'poke')).toEqual({
      key: 'poke',
      label: 'Meeting requests',
      description: "When someone you haven't met sends you a meeting request",
    });
  });

  it('keeps the keys, which name the preference columns the server stores', () => {
    expect(rows.map((r) => r.key)).toEqual(['dm', 'poke', 'group', 'invite', 'report_resolved']);
  });

  it('shows the member no row that says "poke"', () => {
    for (const row of rows) {
      expect(`${row.label} ${row.description}`).not.toMatch(/poke/i);
    }
  });

  it('has no other "poke" anywhere on the page (the row key is the one allowed use)', () => {
    const lines = SETTINGS.replace("key: 'poke'", '').split('\n');
    expect(lines.filter((line) => /poke/i.test(line))).toEqual([]);
  });
});
