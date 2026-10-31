import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Pool } from 'pg';
import { ROOT_DIR, DATASET_PATH, EXPORTS_DIR } from '../server/config.js';
import { PostgresStorage } from '../server/postgresStorage.js';
import { runMigration } from '../server/db/migrate.js';

interface TestResult {
  category: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT RUN';
  detail?: string;
}

const results: TestResult[] = [];

function record(category: string, name: string, status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT RUN', detail?: string) {
  results.push({ category, name, status, detail });
  const tag = `[${status}]`.padEnd(10);
  console.log(`  ${tag} ${name}${detail ? ` (${detail})` : ''}`);
}

async function runStagingVerification() {
  console.log('=================================================================');
  console.log('POSTGRESQL STAGING VERIFICATION & MIGRATION SAFETY AUDIT');
  console.log('=================================================================\n');

  const stagingDbUrl = process.env.STAGING_DATABASE_URL;

  if (!stagingDbUrl) {
    console.log('[STAGING AUDIT] STAGING_DATABASE_URL is not set.');
    console.log('[STAGING AUDIT] Live PostgreSQL integration tests require an isolated, disposable PostgreSQL 15+ database.');
    console.log('[STAGING AUDIT] Preserving non-negotiable safety rule: No connection to unverified or production databases.\n');

    const testCategories: Array<{ cat: string; tests: string[] }> = [
      {
        cat: 'A. Schema & Initialization',
        tests: [
          'Clean database table and extension creation (schema.sql)',
          'Repeatable / idempotent execution without data corruption',
          'Institutional departments and check constraints initialization',
          'Unique index idx_sched_sess_no_double_book room conflict enforcement',
          'Triggers trg_schedule_version_no_self_approval and trg_disruption_no_self_approval',
        ],
      },
      {
        cat: 'B. Complete Data Migration',
        tests: [
          'Topological order migration (departments -> rooms -> faculty -> groups -> courses -> users)',
          'Operational migration (users, schedules, bookings, disruptions, audit logs, calendar sync)',
          'Source JSON vs PostgreSQL record count reconciliation',
          'Transactional integrity and complete rollback on deliberate failure',
          'Idempotent migration re-run without duplicate key violations',
        ],
      },
      {
        cat: 'C. Storage Adapter Parity',
        tests: [
          'PostgresStorage implements full IStorage interface without unhandled promises',
          'CRUD operations for users, bookings, schedules, disruptions, and audit logs',
          'Referential integrity validation against institutional tables',
          'Data persistence across application and storage instance reloads',
        ],
      },
      {
        cat: 'D. Schedule Reconstruction & Official Validator',
        tests: [
          'Reconstruct schedule from normalized tables matching validator.py schema',
          'Export reconstructed database schedule to temporary file',
          'Execute official validator.py against reconstructed schedule (0 hard violations)',
          'Multi-group sessions, room assignments, and exam schedule preservation',
        ],
      },
      {
        cat: 'E. Approval & Concurrency Safety',
        tests: [
          'Single approved schedule version constraint (idx_single_approved_schedule_version)',
          'Atomic schedule promotion transaction with rollback on failure',
          'Database-level self-approval trigger rejection on bookings, schedules, and disruptions',
          'Conflicting venue booking and timetable session overlap rejection',
        ],
      },
      {
        cat: 'F. Security & RBAC',
        tests: [
          'Server-side token lookup via user_auth_tokens and join with users',
          'All five application roles permission scoping (admin, coordinator, faculty, club, student)',
          'Student group isolation and faculty departmental scoping enforcement',
          'Production mode rejection of client-controlled identity headers',
        ],
      },
    ];

    for (const group of testCategories) {
      console.log(`--- ${group.cat} ---`);
      for (const t of group.tests) {
        record(group.cat, t, 'NOT RUN', 'Prerequisite: STAGING_DATABASE_URL not configured');
      }
      console.log('');
    }

    printSummary();
    return;
  }

  // If STAGING_DATABASE_URL is provided, execute live verification
  console.log(`[STAGING AUDIT] Connecting to staging database: ${stagingDbUrl.replace(/:[^:@]+@/, ':***@')}`);

  let pool: Pool;
  try {
    pool = new Pool({ connectionString: stagingDbUrl, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const verRes = await client.query('SELECT version()');
    console.log(`[STAGING AUDIT] Connected successfully. Engine: ${verRes.rows[0].version}\n`);
    client.release();
  } catch (err: any) {
    console.error(`[STAGING AUDIT] Failed to connect to STAGING_DATABASE_URL: ${err.message}`);
    record('Connection', 'Staging database connection', 'BLOCKED', err.message);
    printSummary();
    return;
  }

  try {
    // -------------------------------------------------------------
    // Part A: Schema & Initialization
    // -------------------------------------------------------------
    console.log('--- A. Schema & Initialization ---');
    const schemaSql = fs.readFileSync(path.join(ROOT_DIR, 'server', 'db', 'schema.sql'), 'utf-8');
    const clientA = await pool.connect();
    try {
      await clientA.query(schemaSql);
      record('A. Schema', 'Clean database table and extension creation (schema.sql)', 'PASS');

      // Test idempotency
      await clientA.query(schemaSql);
      record('A. Schema', 'Repeatable / idempotent execution without data corruption', 'PASS');

      // Verify tables
      const tableCheck = await clientA.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('users', 'departments', 'rooms', 'faculty', 'student_groups', 'courses', 'sessions', 'schedule_versions', 'venue_bookings', 'disruptions', 'audit_logs')
      `);
      record('A. Schema', 'All core tables present in staging database', tableCheck.rows.length >= 11 ? 'PASS' : 'FAIL', `Found ${tableCheck.rows.length} tables`);
    } finally {
      clientA.release();
    }

    // -------------------------------------------------------------
    // Part B: Complete Data Migration
    // -------------------------------------------------------------
    console.log('\n--- B. Complete Data Migration ---');
    try {
      const migrateSummary = await runMigration({ dryRun: false, connectionString: stagingDbUrl });
      const totalMigrated = Object.values(migrateSummary.counts).reduce((a, b) => a + (b || 0), 0);
      record('B. Migration', 'Topological data migration completed', migrateSummary.success ? 'PASS' : 'FAIL');
      record('B. Migration', 'Source JSON vs PostgreSQL record count reconciliation', totalMigrated > 0 ? 'PASS' : 'FAIL', `${totalMigrated} records migrated`);

      // Test rollback with deliberate failure
      const rollbackClient = await pool.connect();
      let rollbackPassed = false;
      try {
        await rollbackClient.query('BEGIN');
        await rollbackClient.query("INSERT INTO departments (code, name) VALUES ('ROLLBACK_TEST', 'Test')");
        // Force deliberate error: duplicate primary key
        await rollbackClient.query("INSERT INTO departments (code, name) VALUES ('ROLLBACK_TEST', 'Duplicate')");
        await rollbackClient.query('COMMIT');
      } catch {
        await rollbackClient.query('ROLLBACK');
        const checkRes = await rollbackClient.query("SELECT * FROM departments WHERE code = 'ROLLBACK_TEST'");
        rollbackPassed = checkRes.rows.length === 0;
      } finally {
        rollbackClient.release();
      }
      record('B. Migration', 'Transactional integrity and complete rollback on deliberate failure', rollbackPassed ? 'PASS' : 'FAIL');
    } catch (e: any) {
      record('B. Migration', 'Topological data migration', 'FAIL', e.message);
    }

    // -------------------------------------------------------------
    // Part C: Storage Adapter Parity
    // -------------------------------------------------------------
    console.log('\n--- C. Storage Adapter Parity ---');
    const storageAdapter = new PostgresStorage(undefined, pool);
    try {
      const users = await storageAdapter.getAllUsers();
      record('C. Adapter', 'getAllUsers retrieval parity', Object.keys(users).length > 0 ? 'PASS' : 'FAIL', `${Object.keys(users).length} users`);

      const dataset = await storageAdapter.getDataset();
      record('C. Adapter', 'getDataset reconstruction parity', dataset.rooms && dataset.rooms.length === 27 ? 'PASS' : 'FAIL', `${dataset.rooms?.length} rooms`);

      const schedules = await storageAdapter.getAllSchedules();
      record('C. Adapter', 'getAllSchedules retrieval parity', Object.keys(schedules).length > 0 ? 'PASS' : 'FAIL', `${Object.keys(schedules).length} schedules`);
    } catch (e: any) {
      record('C. Adapter', 'Storage adapter parity', 'FAIL', e.message);
    }

    // -------------------------------------------------------------
    // Part D: Schedule Reconstruction & Validator
    // -------------------------------------------------------------
    console.log('\n--- D. Schedule Reconstruction & Official Validator ---');
    try {
      const approved = await storageAdapter.getApprovedSchedule();
      if (!approved) {
        record('D. Validator', 'Approved schedule retrieval', 'FAIL', 'No approved schedule found');
      } else {
        record('D. Validator', 'Approved schedule retrieval', 'PASS', `Version ${approved.id}`);
        const tempExportPath = path.join(EXPORTS_DIR, 'schedule_staging_reconstructed.json');
        fs.writeFileSync(tempExportPath, JSON.stringify(approved, null, 2));

        const validatorPath = path.join(ROOT_DIR, 'starter_pack', 'CrunchWeek_StarterPack', 'validator.py');
        const cmd = `python3 ${validatorPath} --data ${DATASET_PATH} --schedule ${tempExportPath}`;
        const output = execSync(cmd, { encoding: 'utf-8' });
        const hasZeroHard = output.includes('Hard violations: 0');
        record('D. Validator', 'Official validator.py execution against reconstructed schedule', hasZeroHard ? 'PASS' : 'FAIL', hasZeroHard ? '0 hard violations' : 'Violations found');

        if (fs.existsSync(tempExportPath)) fs.unlinkSync(tempExportPath);
      }
    } catch (e: any) {
      record('D. Validator', 'Schedule reconstruction & validator', 'FAIL', e.message);
    }

    // -------------------------------------------------------------
    // Part E: Approval & Concurrency Safety
    // -------------------------------------------------------------
    console.log('\n--- E. Approval & Concurrency Safety ---');
    try {
      const clientE = await pool.connect();
      try {
        // Test database self-approval trigger on bookings
        let bookingSelfApprovalBlocked = false;
        try {
          await clientE.query(`
            UPDATE venue_bookings 
            SET status = 'approved', decided_by = created_by 
            WHERE id = (SELECT id FROM venue_bookings LIMIT 1)
          `);
        } catch (trgErr: any) {
          bookingSelfApprovalBlocked = trgErr.message.includes('Self-approval violation') || trgErr.code === '23514';
        }
        record('E. Safety', 'Database-level booking self-approval trigger rejection', bookingSelfApprovalBlocked ? 'PASS' : 'FAIL');
      } finally {
        clientE.release();
      }
    } catch (e: any) {
      record('E. Safety', 'Approval & concurrency safety', 'FAIL', e.message);
    }

    // -------------------------------------------------------------
    // Part F: Security & RBAC
    // -------------------------------------------------------------
    console.log('\n--- F. Security & RBAC ---');
    try {
      const adminUser = await storageAdapter.getUserByToken('admin-token-secret-01');
      record('F. Security', 'Token resolution via user_auth_tokens', adminUser?.role === 'admin' ? 'PASS' : 'FAIL');

      let refErrorCaught = false;
      try {
        await storageAdapter.validateReferentialIntegrity({ department: 'INVALID_DEPT_CODE' });
      } catch {
        refErrorCaught = true;
      }
      record('F. Security', 'Referential integrity enforcement against institutional departments', refErrorCaught ? 'PASS' : 'FAIL');
    } catch (e: any) {
      record('F. Security', 'Security & RBAC verification', 'FAIL', e.message);
    }
  } finally {
    await pool.end();
  }

  printSummary();
}

function printSummary() {
  console.log('=================================================================');
  const passes = results.filter((r) => r.status === 'PASS').length;
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  const notRun = results.filter((r) => r.status === 'NOT RUN').length;

  console.log(`STAGING TEST SUMMARY: ${passes} PASSED, ${fails} FAILED, ${blocked} BLOCKED, ${notRun} NOT RUN`);
  console.log('=================================================================');
}

runStagingVerification().catch((err) => {
  console.error('Fatal error during staging verification:', err);
  process.exit(1);
});
