// ─── Validate Middleware Tests ───────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateAll } from '../../middleware/validate';

function createRequest(overrides: Partial<{ body: any; params: any; query: any }> = {}): Request {
  return {
    body: overrides.body || {},
    params: overrides.params || {},
    query: overrides.query || {},
  } as Request;
}

describe('validate middleware', () => {
  let next: jest.MockedFunction<NextFunction>;
  const res = {} as Response;

  beforeEach(() => {
    next = jest.fn();
  });

  it('should pass and parse valid body', () => {
    const schema = z.object({
      email: z.string().email(),
      name: z.string().min(2),
    });

    const req = createRequest({ body: { email: 'test@example.com', name: 'John' } });
    validate(schema, 'body')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body.email).toBe('test@example.com');
    expect(req.body.name).toBe('John');
  });

  it('should strip extra fields with Zod strict parsing', () => {
    const schema = z.object({
      name: z.string(),
    }).strict();

    const req = createRequest({ body: { name: 'John', extra: 'field' } });
    validate(schema, 'body')(req, res, next);

    // strict() should cause validation error for extra fields
    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(400);
  });

  it('should call next with ValidationError for invalid input', () => {
    const schema = z.object({
      email: z.string().email(),
    });

    const req = createRequest({ body: { email: 'not-an-email' } });
    validate(schema, 'body')(req, res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toHaveProperty('email');
  });

  it('should collect multiple field errors', () => {
    const schema = z.object({
      email: z.string().email(),
      name: z.string().min(2),
      age: z.number().min(18),
    });

    const req = createRequest({ body: { email: 'bad', name: 'A', age: 5 } });
    validate(schema, 'body')(req, res, next);

    const err = next.mock.calls[0][0] as any;
    expect(Object.keys(err.details).length).toBeGreaterThanOrEqual(3);
  });

  it('should validate params target', () => {
    const schema = z.object({
      id: z.string().uuid(),
    });

    const req = createRequest({ params: { id: 'not-a-uuid' } });
    validate(schema, 'params')(req, res, next);

    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(400);
  });

  it('should validate query target', () => {
    const schema = z.object({
      page: z.coerce.number().min(1),
    });

    const req = createRequest({ query: { page: '0' } });
    validate(schema, 'query')(req, res, next);

    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(400);
  });

  it('should pass valid params', () => {
    const schema = z.object({
      id: z.string().uuid(),
    });

    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const req = createRequest({ params: { id: validUuid } });
    validate(schema, 'params')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.params.id).toBe(validUuid);
  });
});

describe('validateAll middleware', () => {
  let next: jest.MockedFunction<NextFunction>;
  const res = {} as Response;

  beforeEach(() => {
    next = jest.fn();
  });

  it('should validate multiple targets at once', () => {
    const schemas = {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ name: z.string().min(2) }),
    };

    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const req = createRequest({
      params: { id: validUuid },
      body: { name: 'John' },
    });

    validateAll(schemas)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should aggregate errors from multiple targets', () => {
    const schemas = {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ name: z.string().min(2) }),
    };

    const req = createRequest({
      params: { id: 'not-uuid' },
      body: { name: 'A' },
    });

    validateAll(schemas)(req, res, next);

    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(400);
    expect(err.details).toBeDefined();
    // Should have errors for both targets
    const keys = Object.keys(err.details);
    expect(keys.some((k: string) => k.startsWith('params'))).toBe(true);
    expect(keys.some((k: string) => k.startsWith('body'))).toBe(true);
  });
});
