import { Router, Response } from 'express';
import { AuthenticatedRequest, assertNotSelfApproval, requireRole } from '../auth.js';
import { PythonBridge } from '../pythonBridge.js';
import { ScheduleVersion, storage } from '../storage.js';
import { DATASET_PATH } from '../config.js';

const router = Router();

router.get('/timetable', async (req: AuthenticatedRequest, res: Response) => {
  const versionId = req.query.version as string;
  const statusFilter = req.query.status as string;

  let schedule: ScheduleVersion | null = null;
  if (versionId) {
    schedule = await storage.getScheduleById(versionId);
  } else if (statusFilter === 'proposed') {
    const all = await storage.getAllSchedules();
    schedule = Object.values(all).find((s) => s.status === 'proposed') || null;
  } else {
    schedule = await storage.getApprovedSchedule();
  }

  if (!schedule) {
    res.status(404).json({
      success: false,
      error: { code: 'TIMETABLE_NOT_FOUND', message: 'No matching schedule version found' },
    });
    return;
  }

  const dataset = await storage.getDataset();
  const sessionsMeta = new Map((dataset.sessions || []).map((s: any) => [s.id, s]));
  const facultyMeta = new Map((dataset.faculty || []).map((f: any) => [f.id, f]));
  const roomsMeta = new Map((dataset.rooms || []).map((r: any) => [r.id, r]));

  // Apply filters
  const groupFilter = req.query.group as string;
  const facultyFilter = req.query.faculty as string;
  const roomFilter = req.query.room as string;
  const dayFilter = req.query.day as string;

  let filteredSessions = schedule.sessions.map((item) => {
    const meta: any = sessionsMeta.get(item.session_id) || {};
    const fac: any = facultyMeta.get(meta.faculty_id) || {};
    const rm: any = roomsMeta.get(item.room_id) || {};

    return {
      session_id: item.session_id,
      day: item.day,
      start_period: item.start_period,
      duration: meta.duration || 1,
      end_period: item.start_period + (meta.duration || 1) - 1,
      room_id: item.room_id,
      room_name: rm.name || item.room_id,
      room_type: rm.type,
      course_id: meta.course_id,
      kind: meta.kind,
      groups: meta.groups || [],
      faculty_id: meta.faculty_id,
      faculty_name: fac.name || meta.faculty_id,
      size: meta.size,
      basket_slot: meta.basket_slot || null,
      needs_accessible: meta.needs_accessible || false,
    };
  });

  if (groupFilter) {
    filteredSessions = filteredSessions.filter((s) => s.groups.includes(groupFilter));
  }
  if (facultyFilter) {
    filteredSessions = filteredSessions.filter((s) => s.faculty_id === facultyFilter);
  }
  if (roomFilter) {
    filteredSessions = filteredSessions.filter((s) => s.room_id === roomFilter);
  }
  if (dayFilter) {
    filteredSessions = filteredSessions.filter((s) => s.day === dayFilter);
  }

  res.json({
    success: true,
    version_id: schedule.id,
    name: schedule.name,
    status: schedule.status,
    created_at: schedule.created_at,
    approved_at: schedule.approved_at,
    approved_by: schedule.approved_by,
    total_sessions_count: schedule.sessions.length,
    filtered_sessions_count: filteredSessions.length,
    soft_penalties: schedule.validator_report?.soft_penalties || {},
    soft_total: schedule.validator_report?.soft_total ?? null,
    data: filteredSessions,
  });
});

router.get('/timetable/versions', async (req: AuthenticatedRequest, res: Response) => {
  const all = await storage.getAllSchedules();
  const versionsList = Object.values(all).map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    created_at: s.created_at,
    created_by: s.created_by,
    approved_at: s.approved_at,
    approved_by: s.approved_by,
    session_count: s.sessions.length,
    hard_violations: s.validator_report?.hard_violation_count ?? 0,
    soft_total: s.validator_report?.soft_total ?? null,
  }));

  res.json({ success: true, count: versionsList.length, data: versionsList });
});

router.get('/timetable/session/:id', async (req: AuthenticatedRequest, res: Response) => {
  const sid = req.params.id;
  const schedule = await storage.getApprovedSchedule();
  if (!schedule) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No approved schedule available' } });
    return;
  }

  const sessionSlot = schedule.sessions.find((s) => s.session_id === sid);
  if (!sessionSlot) {
    res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session ${sid} not found in timetable` } });
    return;
  }

  const dataset = await storage.getDataset();
  const meta = (dataset.sessions || []).find((s: any) => s.id === sid);
  const room = (dataset.rooms || []).find((r: any) => r.id === sessionSlot.room_id);
  const faculty = (dataset.faculty || []).find((f: any) => f.id === meta?.faculty_id);

  res.json({
    success: true,
    data: {
      ...sessionSlot,
      metadata: meta,
      room_details: room,
      faculty_details: faculty,
    },
  });
});

router.post('/timetable/generate', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { seed = 42, autoApprove = false, name } = req.body;

    // Run deterministic Python solver
    const solveResult = await PythonBridge.runSolver(DATASET_PATH, {
      teamName: 'CIT Arch Team',
      seed: Number(seed),
    });

    const report = solveResult.baselineReport;
    const hasHardViolations = report.hard_violation_count > 0;

    const versionId = `v_${Date.now()}`;
    const newVersion: ScheduleVersion = {
      id: versionId,
      name: name || `Generated Timetable (${new Date().toLocaleDateString()})`,
      status: hasHardViolations ? 'rejected' : autoApprove ? 'approved' : 'proposed',
      created_at: new Date().toISOString(),
      created_by: req.user!.id,
      approved_at: autoApprove && !hasHardViolations ? new Date().toISOString() : undefined,
      approved_by: autoApprove && !hasHardViolations ? req.user!.id : undefined,
      dataset_id: solveResult.baselineSchedule.dataset_id,
      team: solveResult.baselineSchedule.team,
      sessions: solveResult.baselineSchedule.sessions,
      fest_week: solveResult.baselineSchedule.fest_week,
      exams: solveResult.baselineSchedule.exams,
      validator_report: report,
    };

    if (hasHardViolations) {
      await storage.logAudit({
        user_id: req.user!.id,
        user_name: req.user!.name,
        role: req.user!.role,
        action: 'TIMETABLE_GENERATE_FAILED',
        resource_type: 'timetable',
        details: { violations: report.hard_violations },
        status: 'failure',
      });

      res.status(422).json({
        success: false,
        error: {
          code: 'SCHEDULE_VALIDATION_FAILED',
          message: `Generated schedule contains ${report.hard_violation_count} hard violations. Cannot be approved.`,
          violations: report.hard_violations,
        },
      });
      return;
    }

    // Save version
    await storage.saveSchedule(newVersion);

    if (autoApprove) {
      await storage.promoteSchedule(newVersion.id, req.user!.id);
    }

    await storage.logAudit({
      user_id: req.user!.id,
      user_name: req.user!.name,
      role: req.user!.role,
      action: autoApprove ? 'TIMETABLE_GENERATE_AND_APPROVE' : 'TIMETABLE_GENERATE_PROPOSED',
      resource_type: 'timetable',
      resource_id: versionId,
      details: {
        session_count: newVersion.sessions.length,
        execution_time_ms: solveResult.executionTimeMs,
        soft_total: report.soft_total,
      },
      status: 'success',
    });

    res.status(201).json({
      success: true,
      message: autoApprove
        ? 'Schedule generated, verified by official validator with 0 violations, and approved'
        : 'Schedule generated and verified by official validator. Pending approval.',
      version_id: versionId,
      status: newVersion.status,
      session_count: newVersion.sessions.length,
      execution_time_ms: solveResult.executionTimeMs,
      validation: {
        hard_violations: report.hard_violation_count,
        soft_total: report.soft_total,
        soft_penalties: report.soft_penalties,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: { code: 'GENERATION_ERROR', message: err.message },
    });
  }
});

router.post('/timetable/:id/approve', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const versionId = req.params.id;
  const schedule = await storage.getScheduleById(versionId);

  if (!schedule) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Version ${versionId} not found` } });
    return;
  }

  // Enforce self-approval prevention
  try {
    assertNotSelfApproval(req, schedule.created_by);
  } catch (err: any) {
    res.status(err.status || 403).json({
      success: false,
      error: { code: err.code || 'SELF_APPROVAL_FORBIDDEN', message: err.message },
    });
    return;
  }

  if (schedule.validator_report?.hard_violation_count > 0) {
    res.status(400).json({
      success: false,
      error: {
        code: 'CANNOT_APPROVE_VIOLATIONS',
        message: 'Cannot approve schedule version with hard violations.',
      },
    });
    return;
  }

  // Atomically promote schedule version
  const promoted = await storage.promoteSchedule(versionId, req.user!.id);

  await storage.logAudit({
    user_id: req.user!.id,
    user_name: req.user!.name,
    role: req.user!.role,
    action: 'APPROVE_TIMETABLE_VERSION',
    resource_type: 'timetable',
    resource_id: versionId,
    status: 'success',
  });

  res.json({
    success: true,
    message: `Schedule version ${versionId} is now the active approved schedule`,
    data: { id: promoted.id, status: promoted.status, approved_at: promoted.approved_at },
  });
});

export default router;
