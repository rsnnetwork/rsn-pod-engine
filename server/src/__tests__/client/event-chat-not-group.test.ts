// Stefan, 22 Nov 2026, on the chat that people start after an event: "That's an event. Not a group." There are no groups
// on REASON, so a chat started after an event is the event's chat and a pod's chat is the pod's. Nothing a person reads
// in these chats, on the event page or in Settings calls them a group any more, and an event chat leads back to its event.
import * as fs from 'fs';
import * as path from 'path';
import * as words from '../../../../client/src/features/messages/group-chat-text';
import { GROUP_COPY } from '../../services/dm/group.service';

const client = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
const server = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

describe('an event chat is the event\'s, not a group', () => {
  it('no sentence the chat screens say uses the word group', () => {
    const said = Object.entries(words)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, v as string]);
    expect(said.length).toBeGreaterThan(20);
    for (const [name, text] of said) expect([name, /\bgroups?\b/i.test(text)]).toEqual([name, false]);
    expect(words.removeAsk('Ana')).toBe('Remove Ana from the chat?');
    expect(words.removedSentence('Ana')).toBe('Ana is no longer in the chat.');
  });

  it('the server\'s refusals say chat too', () => {
    for (const [key, text] of Object.entries(GROUP_COPY)) expect([key, /\bgroups?\b/i.test(String(text))]).toEqual([key, false]);
    expect(server('routes/groups.ts')).not.toMatch(/'[^']*\bgroup (can hold|name)[^']*'/);
    expect(server('middleware/rateLimit.ts')).toContain("'You have started a lot of chats this hour. Try again later.'");
    expect(server('services/dm/group.service.ts')).toContain("row.title?.trim() || 'Event chat'");
  });

  it('each chat says what kind it is', () => {
    expect(words.chatKindLabel('event')).toBe('Event chat');
    expect(words.chatKindLabel('pod')).toBe('Pod chat');
    expect(words.chatKindLabel('custom')).toBe('Chat');
    expect(client('features/messages/GroupInboxRow.tsx')).toContain('{chatKindLabel(group.type)} · {memberCountLabel(group.memberCount)}');
    expect(client('features/messages/GroupThread.tsx')).toContain('{chatKindLabel(group.type)} · {ofMax(group.memberCount)}');
  });

  it('an event chat\'s header opens its event with a 44px link', () => {
    const src = client('features/messages/GroupThread.tsx');
    expect(src).toMatch(/group\.type === 'event' && group\.sessionId && \(\s*<Link\s+to=\{`\/sessions\/\$\{group\.sessionId\}`\}\s+data-testid="group-open-event"/);
    const link = src.slice(src.indexOf('data-testid="group-open-event"'), src.indexOf('</Link>', src.indexOf('data-testid="group-open-event"')));
    expect(link).toContain('min-h-[44px]');
    expect(link).toContain('{OPEN_EVENT}');
  });

  it('Settings names event and pod chats, not groups', () => {
    expect(client('features/settings/SettingsPage.tsx')).toContain("{ key: 'group', label: 'Event + pod chats', description: 'New messages in the chats of your events and pods' }");
  });
});
