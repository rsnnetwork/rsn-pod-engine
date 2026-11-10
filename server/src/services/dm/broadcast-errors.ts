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
  }
}

/**
 * A broadcast would have reached an event guest (Part 2, Task 3, fix round 1): messages are for members, so nothing
 * was written and no email goes out. Its own class for the same reason as BroadcastBlockedError: the post-event
 * worker skips the person instead of recording a failure.
 */
export class BroadcastGuestError extends AppError {
  constructor() {
    super(403, ErrorCodes.AUTH_FORBIDDEN, 'Messages are for members. This person came to an event as a guest and is not a member yet.');
  }
}
