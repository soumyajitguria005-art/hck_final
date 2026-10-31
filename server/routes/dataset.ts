import { Router, Response } from 'express';
import { AuthenticatedRequest, requireRole } from '../auth.js';
import { storage } from '../storage.js';

const router = Router();

router.get('/dataset', async (req: AuthenticatedRequest, res: Response) => {
  const dataset = await storage.getDataset();
  const summaryOnly = req.query.summary === 'true';

  if (summaryOnly) {
    res.json({
      success: true,
      data: {
        dataset_id: dataset.dataset_id,
        institute: dataset.institute,
        rooms_count: dataset.rooms?.length || 0,
        faculty_count: dataset.faculty?.length || 0,
        groups_count: dataset.student_groups?.length || 0,
        courses_count: dataset.courses?.length || 0,
        sessions_count: dataset.sessions?.length || 0,
        booking_requests_count: dataset.booking_requests?.length || 0,
        exams_count: dataset.exams?.length || 0,
      },
    });
    return;
  }

  res.json({ success: true, data: dataset });
});

router.get('/dataset/rooms', async (req: AuthenticatedRequest, res: Response) => {
  const dataset = await storage.getDataset();
  const typeFilter = req.query.type as string;
  let rooms = dataset.rooms || [];
  if (typeFilter) {
    rooms = rooms.filter((r: any) => r.type === typeFilter);
  }
  res.json({ success: true, count: rooms.length, data: rooms });
});

router.get('/dataset/faculty', async (req: AuthenticatedRequest, res: Response) => {
  const dataset = await storage.getDataset();
  const deptFilter = req.query.department as string;
  let faculty = dataset.faculty || [];
  if (deptFilter) {
    faculty = faculty.filter((f: any) => f.department === deptFilter);
  }
  res.json({ success: true, count: faculty.length, data: faculty });
});

router.get('/dataset/groups', async (req: AuthenticatedRequest, res: Response) => {
  const dataset = await storage.getDataset();
  res.json({ success: true, count: dataset.student_groups?.length || 0, data: dataset.student_groups || [] });
});

router.get('/dataset/courses', async (req: AuthenticatedRequest, res: Response) => {
  const dataset = await storage.getDataset();
  res.json({ success: true, count: dataset.courses?.length || 0, data: dataset.courses || [] });
});

router.get('/dataset/sessions', async (req: AuthenticatedRequest, res: Response) => {
  const dataset = await storage.getDataset();
  let sessions = dataset.sessions || [];
  const group = req.query.group as string;
  const faculty = req.query.faculty as string;
  const kind = req.query.kind as string;

  if (group) {
    sessions = sessions.filter((s: any) => s.groups?.includes(group));
  }
  if (faculty) {
    sessions = sessions.filter((s: any) => s.faculty_id === faculty);
  }
  if (kind) {
    sessions = sessions.filter((s: any) => s.kind === kind);
  }

  res.json({ success: true, count: sessions.length, data: sessions });
});

router.post('/dataset/validate', (req: AuthenticatedRequest, res: Response) => {
  const data = req.body;
  const errors: string[] = [];

  if (!data.dataset_id) errors.push('Missing dataset_id');
  if (!Array.isArray(data.rooms)) errors.push('Missing or invalid rooms array');
  if (!Array.isArray(data.faculty)) errors.push('Missing or invalid faculty array');
  if (!Array.isArray(data.sessions)) errors.push('Missing or invalid sessions array');
  if (!Array.isArray(data.exams)) errors.push('Missing or invalid exams array');

  if (errors.length > 0) {
    res.status(400).json({
      success: false,
      error: { code: 'DATASET_INVALID', message: 'Dataset schema validation failed', details: errors },
    });
    return;
  }

  res.json({
    success: true,
    message: 'Dataset structure conforms to official schema',
    stats: {
      rooms: data.rooms.length,
      faculty: data.faculty.length,
      sessions: data.sessions.length,
      exams: data.exams.length,
    },
  });
});

router.put('/dataset/room/:id', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const roomId = req.params.id;
  const { features, accessible } = req.body;
  const dataset = await storage.getDataset();
  const room = (dataset.rooms || []).find((r: any) => r.id === roomId);

  if (!room) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Room ${roomId} not found` } });
    return;
  }

  if (Array.isArray(features)) {
    room.features = features;
  }
  if (typeof accessible === 'boolean') {
    room.accessible = accessible;
  }

  await storage.saveDataset(dataset);
  await storage.logAudit({
    user_id: req.user!.id,
    user_name: req.user!.name,
    role: req.user!.role,
    action: 'UPDATE_ROOM',
    resource_type: 'room',
    resource_id: roomId,
    details: { features, accessible },
    status: 'success',
  });

  res.json({ success: true, message: `Room ${roomId} updated successfully`, data: room });
});

export default router;
