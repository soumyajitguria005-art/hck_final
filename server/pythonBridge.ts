import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { PYTHON_EXEC, SOLVER_PATH, VALIDATOR_PATH } from './config.js';

const execFileAsync = promisify(execFile);

// Mutex lock to serialize Python solver runs and prevent export file collision
let isSolverRunning = false;

export interface ValidationReport {
  dataset_id: string;
  schedule_dataset_id: string;
  team: string;
  hard_violation_count: number;
  hard_violations: Array<{ rule: string; where: string; detail: string }>;
  hard_by_rule: Record<string, number>;
  soft_total: number;
  soft_penalties: Record<string, number>;
  bookings?: {
    booking_score: number;
    booking_score_max_if_all_approved: number;
    approved: number;
    alternatives: number;
    rejected: number;
    session_overrides: number;
    priority_inversions: string[];
  };
  exam_soft_penalty?: number;
  stability?: {
    sessions_moved: number;
    time_changed: number;
    room_only_changed: number;
    moved_ids: string[];
  };
  warnings: string[];
}

export class PythonBridge {
  public static async checkEnvironment(): Promise<{
    pythonAvailable: boolean;
    pythonVersion: string;
    solverAvailable: boolean;
    validatorAvailable: boolean;
  }> {
    let pythonVersion = '';
    let pythonAvailable = false;

    try {
      const { stdout } = await execFileAsync(PYTHON_EXEC, ['--version']);
      pythonVersion = stdout.trim();
      pythonAvailable = true;
    } catch (err: any) {
      pythonAvailable = false;
      pythonVersion = err.message || 'Python not available';
    }

    const solverAvailable = fs.existsSync(SOLVER_PATH);
    const validatorAvailable = fs.existsSync(VALIDATOR_PATH);

    return {
      pythonAvailable,
      pythonVersion,
      solverAvailable,
      validatorAvailable,
    };
  }

  public static async validateSchedule(
    dataPath: string,
    schedulePath: string,
    options?: {
      disruptionPath?: string;
      baselinePath?: string;
    }
  ): Promise<ValidationReport> {
    const tmpReportPath = path.join(
      path.dirname(schedulePath),
      `temp_report_${Date.now()}_${Math.random().toString(36).substring(7)}.json`
    );

    const args = [
      VALIDATOR_PATH,
      '--data',
      dataPath,
      '--schedule',
      schedulePath,
      '--json',
      tmpReportPath,
    ];

    if (options?.disruptionPath) {
      args.push('--disruption', options.disruptionPath);
    }
    if (options?.baselinePath) {
      args.push('--baseline', options.baselinePath);
    }

    try {
      await execFileAsync(PYTHON_EXEC, args, { timeout: 20000 });
      if (!fs.existsSync(tmpReportPath)) {
        throw new Error('Validator did not produce a report file.');
      }
      const reportJson = JSON.parse(fs.readFileSync(tmpReportPath, 'utf-8'));
      return reportJson as ValidationReport;
    } catch (err: any) {
      // If validator produced report with violations, check if report file exists
      if (fs.existsSync(tmpReportPath)) {
        try {
          const reportJson = JSON.parse(fs.readFileSync(tmpReportPath, 'utf-8'));
          return reportJson as ValidationReport;
        } catch (_) {}
      }
      const sanitizedMsg = (err.stderr || err.message || 'Validation error').replace(/\/app\/[^\s]+/g, '[path]');
      throw new Error(`Validator execution failed: ${sanitizedMsg}`);
    } finally {
      if (fs.existsSync(tmpReportPath)) {
        try {
          fs.unlinkSync(tmpReportPath);
        } catch (_) {}
      }
    }
  }

  public static async runSolver(
    dataPath: string,
    options?: {
      disruptionPath?: string;
      teamName?: string;
      seed?: number;
    }
  ): Promise<{
    baselineSchedule: any;
    disruptedSchedule?: any;
    baselineReport: ValidationReport;
    disruptedReport?: ValidationReport;
    executionTimeMs: number;
  }> {
    if (isSolverRunning) {
      throw new Error('A scheduling engine task is already in progress. Please wait for it to complete.');
    }

    isSolverRunning = true;
    const t0 = Date.now();
    const tempOutputDir = path.join(
      '/tmp',
      `cit_solve_${Date.now()}_${Math.random().toString(36).substring(7)}`
    );

    try {
      fs.mkdirSync(tempOutputDir, { recursive: true });

      const args = [
        SOLVER_PATH,
        '--data',
        dataPath,
        '--out-dir',
        tempOutputDir,
        '--team',
        options?.teamName || 'CIT Arch Team',
        '--seed',
        String(options?.seed || 42),
      ];

      if (options?.disruptionPath) {
        args.push('--disruption', options.disruptionPath);
      }

      await execFileAsync(PYTHON_EXEC, args, { timeout: 30000 });

      const baselineSchedulePath = path.join(tempOutputDir, 'schedule.json');
      if (!fs.existsSync(baselineSchedulePath)) {
        throw new Error('Scheduling engine completed without generating schedule.json');
      }

      const baselineSchedule = JSON.parse(fs.readFileSync(baselineSchedulePath, 'utf-8'));

      // Validate baseline schedule
      const baselineReport = await this.validateSchedule(dataPath, baselineSchedulePath);

      let disruptedSchedule = undefined;
      let disruptedReport = undefined;

      const disruptedSchedulePath = path.join(tempOutputDir, 'schedule_after.json');
      if (options?.disruptionPath && fs.existsSync(disruptedSchedulePath)) {
        disruptedSchedule = JSON.parse(fs.readFileSync(disruptedSchedulePath, 'utf-8'));
        disruptedReport = await this.validateSchedule(dataPath, disruptedSchedulePath, {
          disruptionPath: options.disruptionPath,
          baselinePath: baselineSchedulePath,
        });
      }

      return {
        baselineSchedule,
        disruptedSchedule,
        baselineReport,
        disruptedReport,
        executionTimeMs: Date.now() - t0,
      };
    } catch (err: any) {
      const sanitized = (err.stderr || err.message || 'Solver execution failed').replace(/\/app\/[^\s]+/g, '[path]');
      throw new Error(`Scheduling engine error: ${sanitized}`);
    } finally {
      isSolverRunning = false;
      // Clean up temporary run directory
      try {
        if (fs.existsSync(tempOutputDir)) {
          fs.rmSync(tempOutputDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  }
}
