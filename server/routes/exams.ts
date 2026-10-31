import { Router, Response } from 'express';
import { AuthenticatedRequest, requireRole } from '../auth.js';
import { storage } from '../storage.js';

const router = Router();

router.get('/exams', async (req: AuthenticatedRequest, res: Response) => {
  const schedule = await storage.getApprovedSchedule();
  if (!schedule || !schedule.exams) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No approved exam timetable found' } });
    return;
  }

  const dataset = await storage.getDataset();
  const examsMeta = new Map((dataset.exams || []).map((e: any) => [e.id, e]));
  const roomsMeta = new Map((dataset.rooms || []).map((r: any) => [r.id, r]));

  const groupFilter = req.query.group as string;
  const courseFilter = req.query.course as string;
  const dayFilter = req.query.day as string;
  const sessionFilter = req.query.session as string;

  let enrichedExams = schedule.exams.map((item) => {
    const meta: any = examsMeta.get(item.exam_id) || {};
    const roomDetails = item.rooms.map((rid) => {
      const r: any = roomsMeta.get(rid) || {};
      return {
        id: rid,
        name: r.name || rid,
        full_capacity: r.capacity || 0,
        exam_capacity: Math.floor((r.capacity || 0) / 2),
      };
    });

    const totalExamCapacity = roomDetails.reduce((acc, r) => acc + r.exam_capacity, 0);

    return {
      exam_id: item.exam_id,
      day: item.day,
      session: item.session, // AM (09:30-11:30) or PM (14:00-16:00)
      timing: item.session === 'AM' ? '09:30 - 11:30' : '14:00 - 16:00',
      course_ids: meta.course_ids || [],
      groups: meta.groups || [],
      size: meta.size || 0,
      duration_hours: meta.duration_hours || 2,
      allocated_rooms: roomDetails,
      total_allocated_capacity: totalExamCapacity,
      capacity_compliant: totalExamCapacity >= (meta.size || 0),
    };
  });

  if (groupFilter) {
    enrichedExams = enrichedExams.filter((e) => e.groups.includes(groupFilter));
  }
  if (courseFilter) {
    enrichedExams = enrichedExams.filter((e) => e.course_ids.includes(courseFilter));
  }
  if (dayFilter) {
    enrichedExams = enrichedExams.filter((e) => e.day === dayFilter);
  }
  if (sessionFilter) {
    enrichedExams = enrichedExams.filter((e) => e.session === sessionFilter);
  }

  res.json({
    success: true,
    count: enrichedExams.length,
    calendar_info: dataset.calendar?.exam_week || {},
    data: enrichedExams,
  });
});

export default router;
