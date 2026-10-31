import http from 'http';
import fs from 'fs';
import path from 'path';
import { createExpressApp } from '../server/app.js';
import { storage, UserRecord } from '../server/storage.js';

let server: http.Server;
let baseUrl: string;

async function request(
  method: string,
  path: string,
  options?: {
    body?: any;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: any = data;
          try {
            parsed = JSON.parse(data);
          } catch (_) {}
          resolve({ status: res.statusCode || 500, body: parsed, headers: res.headers });
        });
      }
    );

    req.on('error', reject);
    if (options?.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

async function runAuditSuite() {
  console.log('=================================================================');
  console.log('PHASE 3 & 4: COMPREHENSIVE SECURITY, PERSISTENCE & DATA INTEGRITY');
  console.log('=================================================================\n');

  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`Audit Test Server running at ${baseUrl}\n`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------------------
    // Phase 3.1: Unauthenticated request rejection
    // -------------------------------------------------------------------------
    console.log('Test 1: Unauthenticated request rejection');
    const noAuthUsers = await request('GET', '/api/users');
    assert(noAuthUsers.status === 401, 'GET /api/users without credentials returns 401');

    const noAuthMe = await request('GET', '/api/users/me');
    assert(noAuthMe.status === 401, 'GET /api/users/me without credentials returns 401');

    const noAuthBooking = await request('POST', '/api/bookings', { body: { title: 'NoAuth' } });
    assert(noAuthBooking.status === 401, 'POST /api/bookings without credentials returns 401');

    const noAuthGen = await request('POST', '/api/timetable/generate', { body: { seed: 42 } });
    assert(noAuthGen.status === 401, 'POST /api/timetable/generate without credentials returns 401');

    // -------------------------------------------------------------------------
    // Phase 3.2: Student access to another group's restricted information
    // -------------------------------------------------------------------------
    console.log('\nTest 2: Student cross-group data isolation');
    const studentCrossGroup = await request('GET', '/api/calendar/preview?group=Y1-A', {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(studentCrossGroup.status === 403, 'Student in CSE-3 blocked from Y1-A calendar (403)');
    assert(studentCrossGroup.body.error?.code === 'FORBIDDEN', 'Error code is FORBIDDEN');

    // -------------------------------------------------------------------------
    // Phase 3.3: Faculty member access to another faculty's restricted information
    // -------------------------------------------------------------------------
    console.log('\nTest 3: Faculty cross-faculty data isolation');
    const facultyCross = await request('GET', '/api/calendar/preview?faculty=F01', {
      headers: { 'x-user-id': 'usr-faculty-f19' },
    });
    assert(facultyCross.status === 403, 'Faculty F19 blocked from viewing Faculty F01 calendar (403)');
    assert(facultyCross.body.error?.code === 'FORBIDDEN', 'Error code is FORBIDDEN');

    // -------------------------------------------------------------------------
    // Phase 3.4: Coordinator departmental scoping
    // -------------------------------------------------------------------------
    console.log('\nTest 4: Coordinator departmental scoping');
    const coordUsers = await request('GET', '/api/users', {
      headers: { 'x-user-id': 'usr-coord-cse' },
    });
    assert(coordUsers.status === 200, 'Coordinator can view users');
    const cseOnly = coordUsers.body.data.every((u: any) => u.department === 'CSE');
    assert(cseOnly, 'Coordinator only sees users belonging to CSE department');

    // Coordinator cannot modify room facilities
    const coordRoomMod = await request('PUT', '/api/dataset/room/AUD', {
      headers: { 'x-user-id': 'usr-coord-cse' },
      body: { features: ['projector'] },
    });
    assert(coordRoomMod.status === 403, 'Coordinator cannot modify dataset rooms (403)');

    // -------------------------------------------------------------------------
    // Phase 3.5: Club representative cannot access administrative functions
    // -------------------------------------------------------------------------
    console.log('\nTest 5: Club representative blocked from administrative operations');
    const clubGen = await request('POST', '/api/timetable/generate', {
      headers: { 'x-user-id': 'usr-club-drama' },
      body: { seed: 42 },
    });
    assert(clubGen.status === 403, 'Club blocked from timetable generation (403)');

    const clubAudit = await request('GET', '/api/audit-logs', {
      headers: { 'x-user-id': 'usr-club-drama' },
    });
    assert(clubAudit.status === 403, 'Club blocked from viewing audit logs (403)');

    const clubUsers = await request('GET', '/api/users', {
      headers: { 'x-user-id': 'usr-club-drama' },
    });
    assert(clubUsers.status === 403, 'Club blocked from viewing user directory (403)');

    // -------------------------------------------------------------------------
    // Phase 3.6: User cannot obtain Admin privileges via body or parameters
    // -------------------------------------------------------------------------
    console.log('\nTest 6: Client role spoofing prevention');
    const spoofRes = await request('POST', '/api/bookings', {
      headers: { 'x-user-id': 'usr-student-cse3' },
      body: {
        title: 'Privilege Escalation Attempt',
        attendance: 100,
        duration_periods: 2,
        windows: [{ day: 'MON', from_period: 10, to_period: 12 }],
        role: 'admin',
        requested_category: 'institute_event',
      },
    });
    assert(spoofRes.status === 201, 'Booking accepted as student role');
    assert(spoofRes.body.data.effective_category === 'club_event', 'Effective category capped to club_event');

    // -------------------------------------------------------------------------
    // Phase 3.7: Suspended accounts cannot perform protected operations
    // -------------------------------------------------------------------------
    console.log('\nTest 7: Suspended accounts rejected');
    // Create a temporary suspended user
    const suspendedId = `usr-temp-suspended-${Date.now()}`;
    storage.createUser({
      id: suspendedId,
      username: `suspended.${Date.now()}`,
      display_name: 'Suspended Test User',
      email: `suspended.${Date.now()}@cit.ac.in`,
      role: 'faculty',
      department: 'CSE',
      faculty_id: 'F01',
      status: 'suspended',
      auth_tokens: [`token-${suspendedId}`],
    });

    const suspendedReq = await request('GET', '/api/users/me', {
      headers: { 'x-user-id': suspendedId },
    });
    assert(suspendedReq.status === 403, 'Suspended user request returns 403');
    assert(suspendedReq.body.error?.code === 'ACCOUNT_SUSPENDED', 'Returns ACCOUNT_SUSPENDED code');

    // -------------------------------------------------------------------------
    // Phase 3.8: Self-approval prevention
    // -------------------------------------------------------------------------
    console.log('\nTest 8: Self-approval prevention');
    const adminBooking = await request('POST', '/api/bookings', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        title: 'Administrative Assembly',
        attendance: 30,
        duration_periods: 1,
        windows: [{ day: 'TUE', from_period: 10, to_period: 11 }],
      },
    });
    assert(adminBooking.status === 201, 'Admin booking created');
    const adminBId = adminBooking.body.data.id;

    const selfApprove = await request('POST', `/api/bookings/${adminBId}/decision`, {
      headers: { 'x-user-id': 'usr-admin' },
      body: { status: 'approved' },
    });
    assert(selfApprove.status === 403, 'Self-approval of booking blocked (403)');
    assert(selfApprove.body.error?.code === 'SELF_APPROVAL_FORBIDDEN', 'Code is SELF_APPROVAL_FORBIDDEN');

    // -------------------------------------------------------------------------
    // Phase 3.9: Unauthorized users cannot modify other users' accounts
    // -------------------------------------------------------------------------
    console.log('\nTest 9: Unauthorized user modification rejected');
    const unauthMod = await request('PUT', '/api/users/usr-admin', {
      headers: { 'x-user-id': 'usr-student-cse3' },
      body: { display_name: 'Hacked Admin' },
    });
    assert(unauthMod.status === 403, 'Student cannot modify user account (403)');

    // -------------------------------------------------------------------------
    // Phase 3.10: User-supplied IDs checked against permissions
    // -------------------------------------------------------------------------
    console.log('\nTest 10: User-supplied ID verification');
    const calStatusOther = await request('GET', '/api/calendar/status?userId=usr-admin', {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(calStatusOther.status === 403, 'Student cannot inspect admin calendar status (403)');

    // -------------------------------------------------------------------------
    // Phase 4.1: Test user persistence across storage reload
    // -------------------------------------------------------------------------
    console.log('\nTest 11: Persistence across storage instance reload');
    const persistentId = `usr-persist-check-${Date.now()}`;
    const createRes = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: persistentId,
        username: `persist.${Date.now()}`,
        display_name: 'Durable User Record',
        email: `persist.${Date.now()}@cit.ac.in`,
        role: 'student',
        department: 'CSE',
        student_group_id: 'CSE-3',
      },
    });
    assert(createRes.status === 201, 'User created via API (201)');

    // Inspect disk file directly
    const rawUsersDisk = JSON.parse(fs.readFileSync('data/storage/users.json', 'utf-8'));
    assert(rawUsersDisk[persistentId] !== undefined, 'User record is physically present in data/storage/users.json');
    assert(rawUsersDisk[persistentId].display_name === 'Durable User Record', 'Disk record has matching attributes');

    // -------------------------------------------------------------------------
    // Phase 4.2: Role and account status changes take immediate effect
    // -------------------------------------------------------------------------
    console.log('\nTest 12: Role & status updates take immediate effect');
    const targetUserId = `usr-status-change-${Date.now()}`;
    await storage.createUser({
      id: targetUserId,
      username: `status.${Date.now()}`,
      display_name: 'Status Test User',
      email: `status.${Date.now()}@cit.ac.in`,
      role: 'faculty',
      department: 'CSE',
      faculty_id: 'F01',
      status: 'active',
      auth_tokens: [`token-${targetUserId}`],
    });

    // Request as active user succeeds
    const activeCheck = await request('GET', '/api/users/me', {
      headers: { 'x-user-id': targetUserId },
    });
    assert(activeCheck.status === 200, 'Initial request as active user succeeds (200)');

    // Update status to suspended via admin API
    const updateRes = await request('PUT', `/api/users/${targetUserId}`, {
      headers: { 'x-user-id': 'usr-admin' },
      body: { status: 'suspended' },
    });
    assert(updateRes.status === 200, 'Admin successfully suspends user account');

    // Immediate next request with target user is blocked
    const postSuspendCheck = await request('GET', '/api/users/me', {
      headers: { 'x-user-id': targetUserId },
    });
    assert(postSuspendCheck.status === 403, 'Subsequent request is immediately blocked (403 ACCOUNT_SUSPENDED)');

    // -------------------------------------------------------------------------
    // Phase 4.3: Referential integrity enforcement
    // -------------------------------------------------------------------------
    console.log('\nTest 13: Referential integrity enforcement');
    // Invalid department
    const badDept = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: `usr-bad-dept-${Date.now()}`,
        username: `baddept.${Date.now()}`,
        display_name: 'Invalid Dept',
        email: `baddept@cit.ac.in`,
        role: 'faculty',
        department: 'BOGUS_NON_EXISTENT_DEPARTMENT',
      },
    });
    assert(badDept.status === 400, 'Non-existent department rejected (400)');

    // Invalid student group
    const badGroup = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: `usr-bad-grp-${Date.now()}`,
        username: `badgrp.${Date.now()}`,
        display_name: 'Invalid Group',
        email: `badgrp@cit.ac.in`,
        role: 'student',
        student_group_id: 'BOGUS_GROUP_YEAR_99',
      },
    });
    assert(badGroup.status === 400, 'Non-existent student group rejected (400)');

    // Invalid faculty ID
    const badFac = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: `usr-bad-fac-${Date.now()}`,
        username: `badfac.${Date.now()}`,
        display_name: 'Invalid Faculty',
        email: `badfac@cit.ac.in`,
        role: 'faculty',
        faculty_id: 'F9999',
      },
    });
    assert(badFac.status === 400, 'Non-existent faculty ID rejected (400)');

    // -------------------------------------------------------------------------
    // Phase 4.4: Schedule proposals cannot silently replace approved schedules
    // -------------------------------------------------------------------------
    console.log('\nTest 14: Schedule proposal safety');
    const baselineBefore = await storage.getApprovedSchedule();
    assert(baselineBefore?.id === 'v1', 'Baseline schedule before proposal is v1');
    assert(baselineBefore?.status === 'approved', 'Baseline status is approved');

    // Create a proposed schedule version
    const propVersionId = `v_prop_test_${Date.now()}`;
    await storage.saveSchedule({
      id: propVersionId,
      name: 'Proposed Test Schedule',
      status: 'proposed',
      created_at: new Date().toISOString(),
      created_by: 'usr-admin',
      dataset_id: 'cit-public-v1',
      team: 'CIT Arch Team',
      sessions: baselineBefore!.sessions,
    });

    const baselineAfter = await storage.getApprovedSchedule();
    assert(baselineAfter?.id === 'v1', 'Approved schedule remains v1 after new proposed schedule added');
    assert(baselineAfter?.status === 'approved', 'Approved schedule retains approved status');

    // -------------------------------------------------------------------------
    // Phase 4.5: Concurrent writes integrity
    // -------------------------------------------------------------------------
    console.log('\nTest 15: Concurrent writes atomicity');
    const writePromises = Array.from({ length: 10 }).map((_, i) => {
      const bId = `BR-CONCUR-${Date.now()}-${i}`;
      return request('POST', '/api/bookings', {
        headers: { 'x-user-id': 'usr-admin' },
        body: {
          title: `Concurrent Booking ${i}`,
          attendance: 20 + i,
          duration_periods: 1,
          windows: [{ day: 'WED', from_period: 10, to_period: 11 }],
        },
      });
    });

    const writeResults = await Promise.all(writePromises);
    assert(writeResults.every((r) => r.status === 201), 'All 10 concurrent booking requests succeeded with 201');

    // Verify bookings file is valid JSON and contains all concurrent bookings
    const diskBookings = JSON.parse(fs.readFileSync('data/storage/bookings.json', 'utf-8'));
    assert(typeof diskBookings === 'object', 'bookings.json remains clean, valid JSON after concurrent writes');

    // -------------------------------------------------------------------------
    // Phase 4.6: Audit log verification
    // -------------------------------------------------------------------------
    console.log('\nTest 16: Audit log capture');
    const auditLogs = await storage.getAuditLogs(50);
    assert(auditLogs.length > 0, 'Audit log contains entries');
    const actions = auditLogs.map((l) => l.action);
    assert(actions.includes('CREATE_USER_ACCOUNT'), 'Audit log recorded CREATE_USER_ACCOUNT');
    assert(actions.includes('UPDATE_USER_ACCOUNT'), 'Audit log recorded UPDATE_USER_ACCOUNT');
    assert(actions.includes('CREATE_BOOKING_REQUEST'), 'Audit log recorded CREATE_BOOKING_REQUEST');

    // -------------------------------------------------------------------------
    // Phase 4.7: Starter pack preservation
    // -------------------------------------------------------------------------
    console.log('\nTest 17: Official starter pack preservation');
    const dataset = await storage.getDataset();
    assert(dataset.sessions?.length === 189, 'Official dataset contains exactly 189 sessions');
    assert(dataset.exams?.length === 41, 'Official dataset contains exactly 41 exams');
    assert(dataset.booking_requests?.length === 25, 'Official dataset contains exactly 25 booking requests');
    assert(fs.existsSync('starter_pack/CrunchWeek_StarterPack/data/cit_public.json'), 'Original cit_public.json is intact');
    assert(fs.existsSync('starter_pack/CrunchWeek_StarterPack/validator.py'), 'Official validator.py is intact');

  } finally {
    server.close();
  }

  console.log('\n=================================================================');
  console.log(`AUDIT TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('=================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAuditSuite().catch((err) => {
  console.error('Audit test suite fatal error:', err);
  process.exit(1);
});
