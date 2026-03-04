// ─── Request Validation Middleware (Zod) ─────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from './errors';

type ValidationTarget = 'body' | 'params' | 'query';

/**
 * Creates a validation middleware that validates the specified request property
 * against a Zod schema. Throws a ValidationError with detailed field errors.
 */
export function validate(schema: ZodSchema, target: ValidationTarget = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const data = schema.parse(req[target]);
      // Replace the request property with parsed (cleaned) data
      (req as unknown as Record<string, unknown>)[target] = data;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details: Record<string, string[]> = {};
        for (const issue of err.issues) {
          const path = issue.path.join('.') || '_root';
          if (!details[path]) {
            details[path] = [];
          }
          details[path].push(issue.message);
        }

        next(new ValidationError('Validation failed', details));
        return;
      }

      next(err);
    }
  };
}

/**
 * Validates multiple targets at once.
 */
export function validateAll(schemas: Partial<Record<ValidationTarget, ZodSchema>>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const allDetails: Record<string, string[]> = {};

    for (const [target, schema] of Object.entries(schemas)) {
      try {
        const data = schema!.parse(req[target as ValidationTarget]);
        (req as unknown as Record<string, unknown>)[target] = data;
      } catch (err) {
        if (err instanceof ZodError) {
          for (const issue of err.issues) {
            const path = `${target}.${issue.path.join('.')}` || target;
            if (!allDetails[path]) {
              allDetails[path] = [];
            }
            allDetails[path].push(issue.message);
          }
        } else {
          next(err);
          return;
        }
      }
    }

    if (Object.keys(allDetails).length > 0) {
      next(new ValidationError('Validation failed', allDetails));
      return;
    }

    next();
  };
}
