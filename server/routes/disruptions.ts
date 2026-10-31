import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { AuthenticatedRequest, assertNotSelfApproval, requireRole } from '../auth.js';
import { CalendarService } from '../calendarService.js';
import { DATASET_PATH } from '../config.js';
import { PythonBridge } from '../pythonBridge.js';
import { DisruptionRecord, ScheduleVersion, storage } from '../storage.js';

const router = Router();

router.get('/disruptions', async (req: AuthenticatedRequest, res: Response) => {
  const disruptions = await storage.getAllDisruptions();
  res.json({
    success: true,
    count: Object.keys(disruptions).length,
    data: Object.values(disruptions),
  });
});

router.get('/disruptions/:id', async (req: AuthenticatedRequest, res: Response) => {
  const disruption = await storage.getDisruptionById(req.params.id);
  if (!disruption) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Disruption ${req.params.id} not found` } });
    return;
  }

  let scheduleDiff = null;
  if (disruption.proposed_schedule_version_id) {
    const proposed = await storage.getScheduleById(disruption.proposed_schedule_version_id);
    const baseline = await storage.getApprovedSchedule();
    if (proposed && baseline) {
      scheduleDiff = CalendarService.compareSchedules(baseline, proposed);
    }
  }

  res.json({
    success: true,
    data: {
      ...disruption,
      diff: scheduleDiff,
    },
  });
});

router.post(
  '/disruptions/propose',
  requireRole('admin', 'department_coordinator'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { title, description, changes } = req.body;

    if (!title || !Array.isArray(changes) || changes.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_DISRUPTION', message: 'Title and non-empty changes array are required.' },
      });
      return;
    }

    const baseline = await storage.getApprovedSchedule();
    if (!baseline) {
      res.status(400).json({
        success: false,
        error: { code: 'NO_BASELINE', message: 'No approved baseline schedule exists to apply disruption onto.' },
      });
      return;
    }

    // Write temporary disruption file for Python engine
    const tmpDisruptionFile = path.join(
      '/tmp',
      `disruption_req_${Date.now()}_${Math.random().toString(36).substring(7)}.json`
    );

    try {
      const disruptionPayload = {
        id: `disruption-${Date.now()}`,
        dataset: baseline.dataset_id,
        description: description || title,
        changes,
      };
      fs.writeFileSync(tmpDisruptionFile, JSON.stringify(disruptionPayload, null, 2), 'utf-8');

      // Run Python repair engine
      const solveResult = await PythonBridge.runSolver(DATASET_PATH, {
        disruptionPath: tmpDisruptionFile,
      });

      if (!solveResult.disruptedSchedule || !solveResult.disruptedReport) {
        throw new Error('Disruption repair engine failed to produce disrupted schedule.');
      }

      const rep = solveResult.disruptedReport;
      if (rep.hard_violation_count > 0) {
        res.status(422).json({
          success: false,
          error: {
            code: 'DISRUPTION_INVIOLABLE',
            message: `Disruption scenario cannot be repaired clash-free: ${rep.hard_violation_count} hard violations.`,
            violations: rep.hard_violations,
          },
        });
        return;
      }

      // Create proposed schedule version (distinct from approved baseline!)
      const proposedVersionId = `v_prop_dis_${Date.now()}`;
      const proposedSchedule: ScheduleVersion = {
        id: proposedVersionId,
        name: `Repaired Timetable: ${title}`,
        status: 'proposed',
        created_at: new Date().toISOString(),
        created_by: req.user!.id,
        dataset_id: baseline.dataset_id,
        team: baseline.team,
        disruption_id: disruptionPayload.id,
        sessions: solveResult.disruptedSchedule.sessions,
        fest_week: baseline.fest_week,
        exams: baseline.exams,
        validator_report: rep,
      };
      await storage.saveSchedule(proposedSchedule);

      // Compute diff
      const changeReport = CalendarService.compareSchedules(baseline, proposedSchedule);

      const disruptionRecord: DisruptionRecord = {
        id: disruptionPayload.id,
        title,
        description,
        submitted_at: new Date().toISOString(),
        submitted_by: req.user!.id,
        status: 'proposed',
        changes,
        proposed_schedule_version_id: proposedVersionId,
        stability_metrics: rep.stability || {
          sessions_moved: changeReport.summary.timeChangedCount + changeReport.summary.roomOnlyChangedCount,
          time_changed: changeReport.summary.timeChangedCount,
          room_only_changed: changeReport.summary.roomOnlyChangedCount,
          moved_ids: [
            ...changeReport.updatedTimeSessions.map((s) => s.sessionId),
            ...changeReport.updatedRoomSessions.map((s) => s.sessionId),
          ],
        },
        validator_report: rep,
      };
      await storage.saveDisruption(disruptionRecord);

      await storage.logAudit({
        user_id: req.user!.id,
        user_name: req.user!.name,
        role: req.user!.role,
        action: 'PROPOSE_DISRUPTION',
        resource_type: 'disruption',
        resource_id: disruptionRecord.id,
        details: { title, moved: disruptionRecord.stability_metrics?.sessions_moved },
        status: 'success',
      });

      res.status(201).json({
        success: true,
        message: 'Disruption scenario repaired and proposed successfully. Baseline schedule remains preserved pending approval.',
        data: disruptionRecord,
        proposed_schedule_version_id: proposedVersionId,
        diff: changeReport,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: { code: 'DISRUPTION_ERROR', message: err.message },
      });
    } finally {
      if (fs.existsSync(tmpDisruptionFile)) {
        try {
          fs.unlinkSync(tmpDisruptionFile);
        } catch (_) {}
      }
    }
  }
);

router.post('/disruptions/:id/approve', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const disruption = await storage.getDisruptionById(req.params.id);
  if (!disruption) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Disruption ${req.params.id} not found` } });
    return;
  }

  // Prevent self-approval
  try {
    assertNotSelfApproval(req, disruption.submitted_by);
  } catch (err: any) {
    res.status(err.status || 403).json({
      success: false,
      error: { code: err.code || 'SELF_APPROVAL_FORBIDDEN', message: err.message },
    });
    return;
  }

  if (!disruption.proposed_schedule_version_id) {
    res.status(400).json({ success: false, error: { code: 'INVALID_STATE', message: 'Disruption has no proposed schedule version.' } });
    return;
  }

  const proposedSchedule = await storage.getScheduleById(disruption.proposed_schedule_version_id);
  if (!proposedSchedule) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Proposed schedule version not found.' } });
    return;
  }

  // Atomically promote proposed schedule to approved
  const promoted = await storage.promoteSchedule(proposedSchedule.id, req.user!.id);

  // Mark disruption approved
  disruption.status = 'approved';
  disruption.approved_by = req.user!.id;
  disruption.approved_at = new Date().toISOString();
  await storage.saveDisruption(disruption);

  await storage.logAudit({
    user_id: req.user!.id,
    user_name: req.user!.name,
    role: req.user!.role,
    action: 'APPROVE_DISRUPTION',
    resource_type: 'disruption',
    resource_id: disruption.id,
    details: { approved_schedule_version: promoted.id },
    status: 'success',
  });

  res.json({
    success: true,
    message: `Disruption '${disruption.title}' approved. Schedule version '${promoted.id}' is now active.`,
    data: {
      disruption_id: disruption.id,
      active_schedule_version: promoted.id,
      approved_at: disruption.approved_at,
    },
  });
});

router.post('/disruptions/:id/reject', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const disruption = await storage.getDisruptionById(req.params.id);
  if (!disruption) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Disruption ${req.params.id} not found` } });
    return;
  }

  try {
    assertNotSelfApproval(req, disruption.submitted_by);
  } catch (err: any) {
    res.status(err.status || 403).json({
      success: false,
      error: { code: err.code || 'SELF_APPROVAL_FORBIDDEN', message: err.message },
    });
    return;
  }

  disruption.status = 'rejected';
  await storage.saveDisruption(disruption);

  if (disruption.proposed_schedule_version_id) {
    const prop = await storage.getScheduleById(disruption.proposed_schedule_version_id);
    if (prop) {
      prop.status = 'rejected';
      await storage.saveSchedule(prop);
    }
  }

  await storage.logAudit({
    user_id: req.user!.id,
    user_name: req.user!.name,
    role: req.user!.role,
    action: 'REJECT_DISRUPTION',
    resource_type: 'disruption',
    resource_id: disruption.id,
    status: 'success',
  });

  res.json({ success: true, message: `Disruption ${disruption.id} rejected`, data: disruption });
});

export default router;
