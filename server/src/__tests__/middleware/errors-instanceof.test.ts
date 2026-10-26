// ─── An AppError subclass is an instance of its own class (26 Oct 2026, H2b item 1) ──────────────────
//
// AppError used to end its constructor with Object.setPrototypeOf(this, AppError.prototype), which pointed
// every instance of every subclass back at AppError's prototype. `err instanceof ConflictError` was then
// false for every ConflictError, so a branch written for one never ran (the invite accept that treats
// "already a member" as success was one), and BroadcastBlockedError had to set its own prototype again to be
// recognised. The prototype is now the one of the class that was constructed (new.target).

import {
  AppError, NotFoundError, UnauthorizedError, ForbiddenError, ValidationError, ConflictError, RateLimitError,
} from '../../middleware/errors';
import { BroadcastBlockedError } from '../../services/dm/broadcast-errors';
import { ErrorCodes } from '@rsn/shared';

/** A subclass written the ordinary way, with no prototype line of its own. */
class LocalRefusal extends AppError {
  constructor() {
    super(418, ErrorCodes.VALIDATION_ERROR, 'Not today');
  }
}

const cases: Array<[string, () => AppError, abstract new (...args: never[]) => AppError]> = [
  ['NotFoundError', () => new NotFoundError('Pod', 'p-1'), NotFoundError],
  ['UnauthorizedError', () => new UnauthorizedError(), UnauthorizedError],
  ['ForbiddenError', () => new ForbiddenError(), ForbiddenError],
  ['ValidationError', () => new ValidationError('Bad input', { name: ['required'] }), ValidationError],
  ['ConflictError', () => new ConflictError(ErrorCodes.POD_MEMBER_EXISTS, 'Already in'), ConflictError],
  ['RateLimitError', () => new RateLimitError(), RateLimitError],
  ['BroadcastBlockedError', () => new BroadcastBlockedError(), BroadcastBlockedError],
  ['a subclass with no prototype line of its own', () => new LocalRefusal(), LocalRefusal],
];

describe('every AppError subclass', () => {
  it.each(cases)('%s is an instance of its own class, of AppError and of Error', (_name, make, Class) => {
    const err = make();
    expect(err instanceof Class).toBe(true);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(err)).toBe(Class.prototype);
  });

  it.each(cases)('%s keeps its status, code, message and stack', (_name, make) => {
    const err = make();
    expect(typeof err.statusCode).toBe('number');
    expect(typeof err.code).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.stack).toContain(err.message);
  });

  it('is not an instance of a sibling class', () => {
    const conflict = new ConflictError(ErrorCodes.POD_FULL, 'Full');
    expect(conflict instanceof NotFoundError).toBe(false);
    expect(conflict instanceof ForbiddenError).toBe(false);
    expect(new ForbiddenError() instanceof ConflictError).toBe(false);
  });

  it('a plain AppError is still an AppError and an Error, and no subclass', () => {
    const err = new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Bad');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof ConflictError).toBe(false);
  });

  it('a thrown ConflictError is caught by its class through an await, as a service throws it', async () => {
    const service = async () => { throw new ConflictError(ErrorCodes.SESSION_ALREADY_REGISTERED, 'Already registered'); };
    await expect(service()).rejects.toBeInstanceOf(ConflictError);
  });
});
