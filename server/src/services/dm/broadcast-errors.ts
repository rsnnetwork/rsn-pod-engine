import { ErrorCodes } from '@rsn/shared';
import { AppError } from '../../middleware/errors';

/**
 * A broadcast would have reached someone who blocked the sender, or whom the sender blocked. Nothing was
 * written. It is a class of its own so the post-event worker can tell this refusal (the person is skipped)
 * from a fault (the person is recorded as failed) without reading a message. To anything that only knows
 * AppError it is the same plain 403 it always was.
 */
export class BroadcastBlockedError extends AppError {
  constructor() {
    super(403, ErrorCodes.AUTH_FORBIDDEN, 'You can no longer message this user');
    // AppError points every subclass back at its own prototype, which would make `instanceof` false here.
    Object.setPrototypeOf(this, BroadcastBlockedError.prototype);
  }
}
