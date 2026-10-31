import { Router, Request, Response } from 'express';
import { PythonBridge } from '../pythonBridge.js';
import { storage } from '../storage.js';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
  try {
    const envCheck = await PythonBridge.checkEnvironment();
    const approvedSchedule = await storage.getApprovedSchedule();
    const dataset = await storage.getDataset();

    const isHealthy =
      envCheck.pythonAvailable && envCheck.solverAvailable && envCheck.validatorAvailable;

    res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      service: 'CIT Campus Scheduling and Venue Management API',
      version: '1.0.0',
      active_schedule_version: approvedSchedule?.id || 'none',
      dataset_id: dataset?.dataset_id || 'none',
      environment: {
        python: {
          available: envCheck.pythonAvailable,
          version: envCheck.pythonVersion,
        },
        scheduling_engine: {
          available: envCheck.solverAvailable,
          deterministic: true,
        },
        validator: {
          available: envCheck.validatorAvailable,
          official: true,
        },
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      status: 'error',
      error: { code: 'HEALTH_CHECK_FAILED', message: err.message },
    });
  }
});

export default router;
