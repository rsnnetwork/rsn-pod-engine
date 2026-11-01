// ─── activeMemberSql: the one way to say "a member others may see" (T2, 1 Nov 2026) ─────────────────────────────
//
// A removed (deactivated), suspended or banned account vanishes from every list, count and send path. Each query says
// so with this fragment, written once, so no surface can drift to its own reading of "active".

import { activeMemberSql } from '../../../services/users/active-member';

describe('activeMemberSql', () => {
  it('names the alias the query gave the users table', () => {
    expect(activeMemberSql('u')).toBe(`u.status = 'active'`);
    expect(activeMemberSql('member_user')).toBe(`member_user.status = 'active'`);
    expect(activeMemberSql('users')).toBe(`users.status = 'active'`);
  });

  it('refuses anything that is not a plain lower-case SQL name, since the alias is written into the SQL', () => {
    for (const bad of ['', 'U', '1u', 'u.status', 'u; DROP TABLE users', 'u--', 'u u', "u'", 'ü']) {
      expect(() => activeMemberSql(bad)).toThrow();
    }
  });
});
