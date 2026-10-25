// ─── Who a broadcast skips: one rule ─────────────────────────────────────────
//
// The plan that makes a job (post-event-message.service.ts) and the worker that sends it
// (post-event-message.worker.ts) used to write this rule out separately. They must never disagree about
// who is left out, so there is one definition and both read it.

import * as fs from 'fs';
import * as path from 'path';
import { skipReasonFor } from '../../../services/post-event-message/skip-rule';

describe('skipReasonFor', () => {
  it('someone with an active account whom nobody has blocked is messaged', () => {
    expect(skipReasonFor({ account_status: 'active', blocked: false })).toBeNull();
  });

  it('a block in either direction is skipped as blocked', () => {
    expect(skipReasonFor({ account_status: 'active', blocked: true })).toBe('blocked');
  });

  it.each(['deactivated', 'suspended', 'banned'])('a %s account is skipped as inactive', (account_status) => {
    expect(skipReasonFor({ account_status, blocked: false })).toBe('inactive');
  });

  it('a closed account that is also blocked is skipped as closed: there is no one to message', () => {
    expect(skipReasonFor({ account_status: 'deactivated', blocked: true })).toBe('inactive');
  });

  it('an account whose status is unknown is not messaged (fail closed)', () => {
    expect(skipReasonFor({ account_status: undefined as unknown as string, blocked: false })).toBe('inactive');
    expect(skipReasonFor({ account_status: '', blocked: false })).toBe('inactive');
  });
});

describe('the plan and the worker read the rule from one place', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../../services/post-event-message', file), 'utf8');

  it.each(['post-event-message.service.ts', 'post-event-message.worker.ts'])('%s imports it and does not write it out again', (file) => {
    const source = read(file);
    expect(source).toMatch(/from '\.\/skip-rule'/);
    expect(source).not.toMatch(/account_status\s*!==\s*'active'/);
  });
});
