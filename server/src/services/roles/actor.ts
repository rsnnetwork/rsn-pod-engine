// ─── Who is acting (Part 2 foundation, Task 2) ──────────────────────────────────────────────────
//
// The signed-in person a service acts for: their id and their platform role, as `req.user` carries them. Every Part 2
// service takes one, so its permission check reads the role from the same place the route verified it.

import type { UserRole } from '@rsn/shared';

export type Actor = { userId: string; role: UserRole };
