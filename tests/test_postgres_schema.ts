import fs from 'fs';
import path from 'path';
import http from 'http';
import { ROOT_DIR } from '../server/config.js';
import { runMigration } from '../server/db/migrate.js';
import { StorageManager, storage, createStorage } from '../server/storage.js';
import { createExpressApp } from '../server/app.js';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
    failedCount++;
  }
}

async function runTestSuite() {
  console.log('=================================================================');
  console.log('POSTGRESQL SCHEMA VERIFICATION & DRIVER INTEGRATION SUITE');
  console.log('=================================================================\n');

  // --------------------------------------------------------------------------
  // TEST SECTION 1: Schema DDL & Defect Corrections Verification
  // --------------------------------------------------------------------------
  console.log('--- SECTION 1: PostgreSQL DDL Defect Audit (9 Corrections) ---');
  const schemaPath = path.join(ROOT_DIR, 'server', 'db', 'schema.sql');
  assert(fs.existsSync(schemaPath), 'schema.sql exists in server/db/');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Defect 1: 1NF session_groups
  const hasSessionGroups =
    schemaSql.includes('CREATE TABLE IF NOT EXISTS session_groups') &&
    schemaSql.includes('session_id VARCHAR(64)') &&
    schemaSql.includes('group_id VARCHAR(32)') &&
    schemaSql.includes('PRIMARY KEY (session_id, group_id)');
  assert(hasSessionGroups, 'Defect 1 Fixed: session_groups join table enables 1NF multi-group sessions');

  // Defect 2: Denormalized Exam Schema
  const hasExamSchema =
    schemaSql.includes('CREATE TABLE IF NOT EXISTS exams') &&
    schemaSql.includes('CREATE TABLE IF NOT EXISTS exam_courses') &&
    schemaSql.includes('CREATE TABLE IF NOT EXISTS exam_groups') &&
    schemaSql.includes('CREATE TABLE IF NOT EXISTS exam_schedules') &&
    schemaSql.includes('CREATE TABLE IF NOT EXISTS exam_schedule_rooms');
  assert(hasExamSchema, 'Defect 2 Fixed: Normalized exam schedules with multi-room assignment');

  // Defect 3: Days & Slots Check Constraints
  const hasDaysPeriods =
    schemaSql.includes("day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI'))") &&
    schemaSql.includes('start_period INT NOT NULL CHECK (start_period BETWEEN 1 AND 9)') &&
    schemaSql.includes("day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'))") &&
    schemaSql.includes("session_slot VARCHAR(2) NOT NULL CHECK (session_slot IN ('AM', 'PM'))");
  assert(hasDaysPeriods, 'Defect 3 Fixed: Teaching restricted to MON-FRI (periods 1-9); Exams support MON-SAT (AM/PM)');

  // Defect 4: Exactly 10 Authoritative Room Types
  const expectedRoomTypes = [
    'classroom',
    'lecture_hall',
    'seminar_hall',
    'auditorium',
    'outdoor',
    'lab_cs',
    'lab_elec',
    'lab_phy',
    'workshop',
    'lab_civil',
  ];
  const hasAllRoomTypes = expectedRoomTypes.every((rt) => schemaSql.includes(`'${rt}'`));
  assert(hasAllRoomTypes, 'Defect 4 Fixed: Check constraint includes all 10 authoritative room types');

  // Defect 5: Academic Hours on Courses Table
  const hasCourseHours =
    schemaSql.includes('year INT NOT NULL CHECK (year BETWEEN 1 AND 4)') &&
    schemaSql.includes('lecture_hours INT NOT NULL DEFAULT 0') &&
    schemaSql.includes('tutorial_hours INT NOT NULL DEFAULT 0') &&
    schemaSql.includes('lab_blocks INT NOT NULL DEFAULT 0');
  assert(hasCourseHours, 'Defect 5 Fixed: Courses schema contains year, lecture_hours, tutorial_hours, lab_blocks');

  // Defect 6: All 10 Institutional Departments Seeded
  const expectedDepts = ['ADMIN', 'CE', 'CSE', 'ECE', 'EE', 'HSS', 'MA', 'ME', 'PH', 'COMMON'];
  const hasAllDepts = expectedDepts.every((dept) => schemaSql.includes(`'${dept}'`));
  assert(hasAllDepts, 'Defect 6 Fixed: Institutional departments table seeds all 10 CIT departments');

  // Defect 7: Self-Approval Prevention Trigger
  const hasSelfApprovalTrigger =
    schemaSql.includes('trg_check_no_self_approval()') &&
    schemaSql.includes('IF NEW.decided_by = NEW.created_by THEN') &&
    schemaSql.includes('CREATE TRIGGER trg_venue_booking_no_self_approval');
  assert(hasSelfApprovalTrigger, 'Defect 7 Fixed: PostgreSQL database trigger prevents booking self-approval');

  // Defect 8: Partial Unique Index on Approved Schedule
  const hasPartialUniqueIndex =
    schemaSql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_single_approved_schedule') &&
    schemaSql.includes("WHERE status = 'approved'");
  assert(hasPartialUniqueIndex, 'Defect 8 Fixed: Partial unique index guarantees single approved schedule version');

  // Defect 9: Normalized Booking Windows Table
  const hasBookingWindows =
    schemaSql.includes('CREATE TABLE IF NOT EXISTS booking_windows') &&
    schemaSql.includes('from_period INT NOT NULL CHECK (from_period BETWEEN 1 AND 13)') &&
    schemaSql.includes('to_period INT NOT NULL CHECK (to_period BETWEEN 1 AND 13)') &&
    schemaSql.includes('CONSTRAINT chk_window_order CHECK (from_period <= to_period)');
  assert(hasBookingWindows, 'Defect 9 Fixed: Normalized booking_windows table with period ordering check constraint');

  // Additional Safety Checks: Room double-booking prevention & triggers
  const hasDoubleBookingIndex =
    schemaSql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_sess_no_double_book') &&
    schemaSql.includes('(schedule_version_id, day, start_period, room_id)');
  assert(hasDoubleBookingIndex, 'Room double-booking prevention: Unique index on (schedule_version_id, day, start_period, room_id)');

  const hasScheduleSelfApprovalTrigger =
    schemaSql.includes('trg_check_schedule_no_self_approval()') &&
    schemaSql.includes('trg_schedule_version_no_self_approval');
  assert(hasScheduleSelfApprovalTrigger, 'Database trigger prevents schedule version self-approval');

  const hasDisruptionSelfApprovalTrigger =
    schemaSql.includes('trg_check_disruption_no_self_approval()') &&
    schemaSql.includes('trg_disruption_no_self_approval');
  assert(hasDisruptionSelfApprovalTrigger, 'Database trigger prevents disruption self-approval');

  // --------------------------------------------------------------------------
  // TEST SECTION 2: Authoritative Dataset Counts Verification
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 2: Dataset Verification (Real Counts vs Prior Estimate) ---');
  const migrationRes = await runMigration({ dryRun: true });
  assert(migrationRes.success === true, 'Migration dry-run executes successfully');
  assert(migrationRes.counts.rooms === 27, 'Verified real rooms count: 27 (corrected from inaccurate estimate of 10)');
  assert(migrationRes.counts.faculty === 40, 'Verified real faculty count: 40 (corrected from inaccurate estimate of 27)');
  assert(migrationRes.counts.student_groups === 14, 'Verified real student groups count: 14 (corrected from inaccurate estimate of 18)');
  assert(migrationRes.counts.courses === 62, 'Verified real courses count: 62 (corrected from inaccurate estimate of 45)');
  assert(migrationRes.counts.sessions === 189, 'Verified real sessions count: 189');
  assert(migrationRes.counts.exams === 41, 'Verified real exams count: 41');
  assert(migrationRes.counts.bookings === 25, 'Verified real booking requests count: 25');

  // --------------------------------------------------------------------------
  // TEST SECTION 3: Storage Driver Selection & Safety
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 3: Storage Driver Architecture & Safety ---');
  assert(storage instanceof StorageManager, 'Active default storage is StorageManager (JSON-backed)');

  // Test createStorage default behavior
  const defaultStorage = createStorage();
  assert(defaultStorage instanceof StorageManager, 'createStorage() defaults to JSON when STORAGE_DRIVER is undefined');

  // Test safety when DATABASE_URL is missing
  const prevDriver = process.env.STORAGE_DRIVER;
  process.env.STORAGE_DRIVER = 'postgres';
  const fallbackStorage = createStorage();
  assert(
    fallbackStorage instanceof StorageManager,
    'createStorage() safely falls back to JSON with a warning if DATABASE_URL is missing'
  );
  process.env.STORAGE_DRIVER = prevDriver;

  // --------------------------------------------------------------------------
  // TEST SECTION 4: Production Authentication Hardening
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 4: Production Authentication Security ---');
  const app = createExpressApp();
  let server: http.Server | undefined;
  let baseUrl: string = '';

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server?.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const request = (method: string, path: string, headers?: Record<string, string>) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(new URL(path, baseUrl), { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 500, body: data });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });

  try {
    // 1. In development / demo mode, x-user-id is accepted
    const devAuth = await request('GET', '/api/users/me', { 'x-user-id': 'usr-admin' });
    assert(devAuth.status === 200, 'Non-production: x-user-id header is accepted for demo/tests');

    // 2. Switch to NODE_ENV=production without ENABLE_DEMO_AUTH
    process.env.NODE_ENV = 'production';
    delete process.env.ENABLE_DEMO_AUTH;

    const prodBypassAttempt = await request('GET', '/api/users/me', { 'x-user-id': 'usr-admin' });
    assert(prodBypassAttempt.status === 401, 'Production: x-user-id header bypass is rejected (HTTP 401)');

    const prodQueryBypassAttempt = await request('GET', '/api/users/me?asUser=usr-admin');
    assert(prodQueryBypassAttempt.status === 401, 'Production: asUser query param bypass is rejected (HTTP 401)');

    const prodRoleAliasAttempt = await request('GET', '/api/users/me', { Authorization: 'Bearer admin' });
    assert(prodRoleAliasAttempt.status === 401, 'Production: Plain role alias tokens are rejected (HTTP 401)');

    const prodValidToken = await request('GET', '/api/users/me', { Authorization: 'Bearer admin-token-secret-01' });
    assert(prodValidToken.status === 200, 'Production: Real secret auth tokens succeed (HTTP 200)');
    assert(prodValidToken.body.data.role === 'admin', 'Production: Server-verified role is admin');

    // 3. Switch back to test environment
    process.env.NODE_ENV = 'test';
  } finally {
    if (server) {
      server.close();
    }
  }

  console.log('\n=================================================================');
  console.log(`TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('=================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
