// ─── An organiser's export of their circle or pod (Shirley pilot S7, 11 Nov 2026; item 20, plan decision D6) ─────
// GET /circles/:id/export?section=space|members|events|posts   a CSV file   its owner and moderators
// GET /pods/:id/export?section=space|members|events|posts      a CSV file   its director and hosts
// GET /circles/archived/mine                                     [{ id, name, archivedAt, myRole }]   fix round 1: the
//     archived circles the member is still owner or moderator of, so the Circles page can offer their export (an
//     archived circle's own page stays closed). Two path segments, so the circle router's GET /:id never shadows it.
// HEAD on an export is refused (405): a log row means a file left, and HEAD sends none.
//
// Twenty files in ten minutes per person (spaceExportLimiter). Each file is written to the access log (audit_log,
// 'space.export_downloaded') in the same transaction that reads it, and only sent once that commits: a failed log
// write refuses the download. The file says no more than the organiser's own screens (space-export-csv.ts).
// Realtime: a download changes no data any screen shows (the access log has no reader yet), so it tells no screen.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SPACE_EXPORT_SECTIONS, type ApiResponse, type SpaceExportSection, type SpaceKind } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { circleReadLimiter, spaceExportLimiter } from '../middleware/rateLimit';
import { exportSpaceSection, listArchivedCirclesIRan } from '../services/space/space-export.service';

export const CHOOSE_A_FILE = 'Choose which file to download.';

export const exportQuery = z.object({
  section: z.enum(SPACE_EXPORT_SECTIONS, { errorMap: () => ({ message: CHOOSE_A_FILE }) }),
}).strict();

function exportHandler(kind: SpaceKind) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // validate() has already replaced req.query with the parsed value, but Express types it loosely.
      const { section } = req.query as unknown as { section: SpaceExportSection };
      const file = await exportSpaceSection(kind, req.params.id, section, { userId: req.user!.userId, role: req.user!.role });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(file.body);
    } catch (err) {
      next(err);
    }
  };
}

/** HEAD would run the GET handler and write a log row for a file nobody received: refused before anything runs. */
function headRefused(_req: Request, res: Response) {
  res.setHeader('Allow', 'GET');
  res.status(405).end();
}

/** Mounted at /api/circles, beside the circle routes (whose paths never take this shape). */
export const circleExportRoutes = Router();
circleExportRoutes.get('/archived/mine', authenticate, circleReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listArchivedCirclesIRan(req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});
circleExportRoutes.head('/:id/export', headRefused);
circleExportRoutes.get('/:id/export', authenticate, spaceExportLimiter, uuidInPath('id', PATH_REFUSALS.circle),
  validate(exportQuery, 'query', CHOOSE_A_FILE), exportHandler('circle'));

/** Mounted at /api/pods, beside the pod routes (whose paths never take this shape). */
export const podExportRoutes = Router();
podExportRoutes.head('/:id/export', headRefused);
podExportRoutes.get('/:id/export', authenticate, spaceExportLimiter, uuidInPath('id', PATH_REFUSALS.pod),
  validate(exportQuery, 'query', CHOOSE_A_FILE), exportHandler('pod'));
