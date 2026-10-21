import express from 'express';
import request from 'supertest';
import { noStore } from '../../middleware/no-store';

describe('noStore', () => {
  const app = express();
  app.use('/api', noStore);
  app.get('/api/state', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/picture', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('png').send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  it('marks an API answer as not to be stored', async () => {
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves a route that sets its own caching alone', async () => {
    const res = await request(app).get('/api/picture');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('touches nothing outside /api', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
