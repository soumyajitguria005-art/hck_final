import { Router, Response } from 'express';
import { AuthenticatedRequest, requireRole } from '../auth.js';
import { storage } from '../storage.js';

const router = Router();

router.get('/audit-logs', requireRole('admin', 'department_coordinator'), async (req: AuthenticatedRequest, res: Response) => {
  const limit = parseInt((req.query.limit as string) || '100', 10);
  const logs = await storage.getAuditLogs(limit);
  res.json({
    success: true,
    count: logs.length,
    data: logs,
  });
});

export default router;
