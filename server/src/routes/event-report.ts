// ─── The organisers' event report (10 Nov 2026 spec, Part 3 Task 4) ─────────────────────────────────────────────
// GET /sessions/:id/report                                   { success, data: EventReport }
// GET /sessions/:id/report?format=csv&section=attendance     a CSV file (also meetings, mutual-matches)
//
// Mounted at /api/sessions beside the event routes. The people running the event read it (its host, co-hosts and
// moderators, its pod's director or host, admins); emails only reach the host, co-hosts and admins. Thirty reads a
// minute per person; a CSV download also counts against twenty in ten minutes, and each one is written to the event's
// history (report.downloaded: which part, how many rows), since member data leaves RSN in it. A read otherwise
// changes nothing, so it tells no screen beyond that history.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ApiResponse, EventReport, EventReportSection } from '@rsn/shared';
import { transaction } from '../db';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { eventReportExportLimiter, eventReportReadLimiter } from '../middleware/rateLimit';
import { emitEventAuditChanged, recordEventAudit } from '../services/audit/event-audit';
import { getEventReport } from '../services/session/event-report.service';
import { eventReportCsv, eventReportCsvRowCount } from '../services/session/event-report-csv';

const router = Router();

const eventParams = z.object({ id: z.string().uuid('Not an event id').transform((s) => s.toLowerCase()) });

export const reportQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  section: z.enum(['attendance', 'meetings', 'mutual-matches']).optional(),
}).strict().refine((q) => q.format === 'json' || !!q.section, {
  message: 'Choose which part of the report to download.',
  path: ['section'],
});
type ReportQuery = { format: 'json' | 'csv'; section?: EventReportSection };

router.get('/:id/report', authenticate, eventReportReadLimiter, validate(eventParams, 'params'),
  validate(reportQuery, 'query', 'Choose which part of the report to download.'), eventReportExportLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // validate() has already replaced req.query with the parsed value, but Express types it loosely.
      const { format, section } = req.query as unknown as ReportQuery;
      const sessionId = req.params.id;
      const actor = { userId: req.user!.userId, role: req.user!.role };
      const report = await getEventReport(sessionId, actor);
      if (format === 'json' || !section) {
        res.json({ success: true, data: report } satisfies ApiResponse<EventReport>);
        return;
      }
      const file = eventReportCsv(report, section);
      // Written before the file leaves, and in a transaction so a failed write refuses the download: who took
      // member data out is never lost.
      await transaction((client) => recordEventAudit({
        sessionId, actorId: actor.userId, action: 'report.downloaded', automatic: false,
        after: { section, rows: eventReportCsvRowCount(report, section) },
      }, client));
      void emitEventAuditChanged(sessionId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(file.body);
    } catch (err) {
      next(err);
    }
  });

export default router;
