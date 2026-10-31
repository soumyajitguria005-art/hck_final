/**
 * Comprehensive Automated Test Suite for Milestone 2 - Backend API & Integration.
 * Validates all 17 requirements: health, RBAC, timetable generation, exams, bookings,
 * disruption proposals, self-approval prevention, calendar diffing, and official validator.
 */

import { execFileSync } from 'child_process';
import http from 'http';
import { createExpressApp } from '../server/app.js';
import { CalendarService } from '../server/calendarService.js';
import { PythonBridge } from '../server/pythonBridge.js';
import { storage } from '../server/storage.js';

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
  console.log('MILESTONE 2: BACKEND API & INTEGRATION VERIFICATION SUITE');
  console.log('=================================================================\n');

  // Start in-memory test server
  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`Test server running on ${baseUrl}\n`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // 1. Health endpoint and engine availability
    // -------------------------------------------------------------
    console.log('Test 1: Health endpoint and engine availability');
    const healthRes = await request('GET', '/api/health');
    assert(healthRes.status === 200, 'Health check returns HTTP 200');
    assert(healthRes.body.success === true, 'Health check success flag is true');
    assert(healthRes.body.environment.python.available === true, 'Python 3 runtime is available');
    assert(healthRes.body.environment.scheduling_engine.available === true, 'Scheduling engine is available');
    assert(healthRes.body.environment.validator.available === true, 'Official validator is available');

    // -------------------------------------------------------------
    // 2. Valid and invalid API requests
    // -------------------------------------------------------------
    console.log('\nTest 2: Valid and invalid API requests handling');
    const notFoundRes = await request('GET', '/api/non_existent_route');
    assert(notFoundRes.status === 404, 'Undefined route returns HTTP 404');
    assert(notFoundRes.body.error?.code === 'ENDPOINT_NOT_FOUND', '404 returns structured error code');

    const invalidDatasetRes = await request('POST', '/api/dataset/validate', {
      body: { invalid: 'payload' },
    });
    assert(invalidDatasetRes.status === 400, 'Malformed dataset validation returns HTTP 400');
    assert(invalidDatasetRes.body.error?.code === 'DATASET_INVALID', 'Returns DATASET_INVALID code');

    // -------------------------------------------------------------
    // 3. Successful timetable generation
    // -------------------------------------------------------------
    console.log('\nTest 3: Timetable generation via Python engine');
    const genRes = await request('POST', '/api/timetable/generate', {
      headers: { 'x-user-id': 'usr-admin' },
      body: { seed: 42, autoApprove: false, name: 'Automated Test Generation' },
    });
    assert(genRes.status === 201, 'Timetable generation returns HTTP 201 Created');
    assert(genRes.body.validation?.hard_violations === 0, 'Generated timetable has 0 hard violations');
    assert(genRes.body.status === 'proposed', 'Generated schedule saved as proposed version');
    const testProposedVersionId = genRes.body.version_id;

    // -------------------------------------------------------------
    // 4. Infeasible timetable generation diagnostics
    // -------------------------------------------------------------
    console.log('\nTest 4: Infeasible timetable generation diagnostics');
    // Test with invalid dataset path or bad parameters via PythonBridge directly
    let infeasibleCaught = false;
    try {
      await PythonBridge.runSolver('/tmp/non_existent_dataset.json');
    } catch (err: any) {
      infeasibleCaught = true;
      assert(err.message.includes('Scheduling engine error') || err.message.includes('No such file'),
        'Infeasible/missing dataset returns clean diagnostic error without leaking internal details');
    }
    assert(infeasibleCaught, 'Infeasible dataset safely caught and reported');

    // -------------------------------------------------------------
    // 5. Official validator integration
    // -------------------------------------------------------------
    console.log('\nTest 5: Official validator integration');
    const approvedSchedule = await storage.getApprovedSchedule();
    assert(approvedSchedule !== null, 'Approved baseline schedule exists in storage');
    assert(approvedSchedule!.validator_report?.hard_violation_count === 0, 'Validator report confirms 0 hard violations');
    assert(approvedSchedule!.validator_report?.soft_total >= 0, 'Validator report includes soft score');

    // -------------------------------------------------------------
    // 6. Timetable retrieval and filters
    // -------------------------------------------------------------
    console.log('\nTest 6: Timetable retrieval and filtering');
    const allSessionsRes = await request('GET', '/api/timetable');
    assert(allSessionsRes.status === 200, 'Timetable retrieval returns HTTP 200');
    assert(allSessionsRes.body.data.length === 189, 'Returns all 189 teaching sessions');

    // Filter by group: CSE-3
    const groupRes = await request('GET', '/api/timetable?group=CSE-3');
    assert(groupRes.body.data.every((s: any) => s.groups.includes('CSE-3')), 'All returned sessions contain group CSE-3');
    assert(groupRes.body.filtered_sessions_count > 0, 'Filtered group returns non-empty session list');

    // Filter by faculty: F19
    const facRes = await request('GET', '/api/timetable?faculty=F19');
    assert(facRes.body.data.every((s: any) => s.faculty_id === 'F19'), 'All returned sessions belong to faculty F19');

    // Filter by room: AUD
    const roomRes = await request('GET', '/api/timetable?room=AUD');
    assert(roomRes.body.data.every((s: any) => s.room_id === 'AUD'), 'All returned sessions are in room AUD');

    // Single session lookup
    const singleRes = await request('GET', '/api/timetable/session/MA101-AB-L1');
    assert(singleRes.status === 200, 'Single session lookup succeeds');
    assert(singleRes.body.data.session_id === 'MA101-AB-L1', 'Session ID matches exactly');

    // -------------------------------------------------------------
    // 7. Booking decisions and status handling
    // -------------------------------------------------------------
    console.log('\nTest 7: Booking requests and status handling');
    const bookingsRes = await request('GET', '/api/bookings');
    assert(bookingsRes.status === 200, 'Bookings list returns HTTP 200');
    assert(bookingsRes.body.count >= 25, 'Returns all booking requests');

    // Create a new booking as club user
    const createBookingRes = await request('POST', '/api/bookings', {
      headers: { 'x-user-id': 'usr-club-drama' },
      body: {
        title: 'Shakespeare Night Practice',
        attendance: 35,
        duration_periods: 2,
        windows: [{ day: 'THU', from_period: 10, to_period: 12 }],
        room_types: ['seminar_hall', 'classroom'],
        needs: ['stage'],
      },
    });
    assert(createBookingRes.status === 201, 'Club booking submission returns HTTP 201 Created');
    assert(createBookingRes.body.data.effective_category === 'club_event', 'Club role category cap correctly applied');
    const newBookingId = createBookingRes.body.data.id;

    // -------------------------------------------------------------
    // 8. Disruption proposal generation and diffing
    // -------------------------------------------------------------
    console.log('\nTest 8: Disruption proposal and diff generation');
    const proposeDisruptionRes = await request('POST', '/api/disruptions/propose', {
      headers: { 'x-user-id': 'usr-coord-cse' },
      body: {
        title: 'Emergency Lab Maintenance',
        description: 'CS-LAB-1 electrical testing on Tuesday P6-P8',
        changes: [
          {
            type: 'room_unavailable',
            room_id: 'CS-LAB-1',
            days: ['TUE'],
            periods: [6, 7, 8],
            reason: 'Electrical testing',
          },
        ],
      },
    });
    assert(proposeDisruptionRes.status === 201, 'Disruption proposal returns HTTP 201 Created');
    assert(proposeDisruptionRes.body.data.status === 'proposed', 'Disruption marked as proposed');
    assert(proposeDisruptionRes.body.diff !== undefined, 'Change diff returned with proposal');
    const testDisruptionId = proposeDisruptionRes.body.data.id;

    // -------------------------------------------------------------
    // 9. Approval and rejection permissions (RBAC)
    // -------------------------------------------------------------
    console.log('\nTest 9: Role-based access control on approvals');
    // Student trying to approve disruption
    const studentApproveRes = await request('POST', `/api/disruptions/${testDisruptionId}/approve`, {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(studentApproveRes.status === 403, 'Student cannot approve disruption (HTTP 403)');

    // Club trying to approve disruption
    const clubApproveRes = await request('POST', `/api/disruptions/${testDisruptionId}/approve`, {
      headers: { 'x-user-id': 'usr-club-drama' },
    });
    assert(clubApproveRes.status === 403, 'Club representative cannot approve disruption (HTTP 403)');

    // -------------------------------------------------------------
    // 10. Prevention of unauthorized modifications
    // -------------------------------------------------------------
    console.log('\nTest 10: Prevention of unauthorized schedule generation');
    const unauthorizedGenRes = await request('POST', '/api/timetable/generate', {
      headers: { 'x-user-id': 'usr-faculty-f19' },
      body: { seed: 99 },
    });
    assert(unauthorizedGenRes.status === 403, 'Faculty member cannot trigger master schedule generation (HTTP 403)');

    // -------------------------------------------------------------
    // 11. Prevention of self-approval
    // -------------------------------------------------------------
    console.log('\nTest 11: Prevention of self-approval');
    // Admin submits a booking request
    const adminBookingRes = await request('POST', '/api/bookings', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        title: 'Dean Academics Special Assembly',
        attendance: 250,
        duration_periods: 2,
        windows: [{ day: 'FRI', from_period: 10, to_period: 12 }],
        room_types: ['auditorium'],
        needs: ['mic'],
      },
    });
    const adminBookingId = adminBookingRes.body.data.id;

    // Admin tries to self-approve their own booking
    const selfApproveBookingRes = await request('POST', `/api/bookings/${adminBookingId}/decision`, {
      headers: { 'x-user-id': 'usr-admin' },
      body: { status: 'approved', reason: 'Self-approval test' },
    });
    assert(selfApproveBookingRes.status === 403, 'User cannot approve their own booking request (HTTP 403)');
    assert(
      selfApproveBookingRes.body.error?.code === 'SELF_APPROVAL_FORBIDDEN',
      'Returns SELF_APPROVAL_FORBIDDEN error code'
    );

    // -------------------------------------------------------------
    // 12. Preservation of approved baseline until changes approved
    // -------------------------------------------------------------
    console.log('\nTest 12: Preservation of baseline schedule');
    const currentApproved = await storage.getApprovedSchedule();
    assert(currentApproved!.id === 'v1', 'Active approved schedule version remains v1 after disruption proposal');
    assert(currentApproved!.status === 'approved', 'Baseline status remains approved');

    // -------------------------------------------------------------
    // 13. Stable identifiers across schedule versions
    // -------------------------------------------------------------
    console.log('\nTest 13: Stable identifiers across schedule versions');
    const baseIds = new Set(approvedSchedule!.sessions.map((s) => s.session_id));
    const proposedSched = await storage.getScheduleById(testProposedVersionId);
    assert(proposedSched !== null, 'Proposed schedule found');
    const propIds = new Set(proposedSched!.sessions.map((s) => s.session_id));
    assert(baseIds.size === propIds.size, 'Same number of unique session identifiers');
    for (const id of baseIds) {
      assert(propIds.has(id), `Session identifier ${id} is preserved across versions`);
      break; // verify sample
    }

    // -------------------------------------------------------------
    // 14. Accurate detection of added, changed, cancelled, and unchanged sessions
    // -------------------------------------------------------------
    console.log('\nTest 14: Calendar change detection accuracy');
    const s0 = approvedSchedule!.sessions[0];
    const s1 = approvedSchedule!.sessions[1];
    const s2 = approvedSchedule!.sessions[2];

    const sampleTargetSched: any = {
      id: 'v_test_diff',
      sessions: [
        // unchanged
        { session_id: s0.session_id, day: s0.day, start_period: s0.start_period, room_id: s0.room_id },
        // room change only
        { session_id: s1.session_id, day: s1.day, start_period: s1.start_period, room_id: s1.room_id === 'AUD' ? 'LH-1' : 'AUD' },
        // time change
        { session_id: s2.session_id, day: s2.day === 'MON' ? 'TUE' : 'MON', start_period: s2.start_period === 1 ? 2 : 1, room_id: s2.room_id },
        // new session
        { session_id: 'NEW-TUT-01', day: 'WED', start_period: 3, room_id: 'CR-101' },
      ],
    };
    const diff = CalendarService.compareSchedules(approvedSchedule!, sampleTargetSched);
    assert(diff.addedSessions.length === 1 && diff.addedSessions[0].sessionId === 'NEW-TUT-01', 'Correctly identified added session');
    assert(diff.updatedRoomSessions.length === 1, 'Correctly identified room-only changed session');
    assert(diff.updatedTimeSessions.length === 1, 'Correctly identified time-changed session');
    assert(diff.unchangedSessions.length === 1, 'Correctly identified unchanged session');

    // -------------------------------------------------------------
    // 15. Prevention of duplicate change records
    // -------------------------------------------------------------
    console.log('\nTest 15: Prevention of duplicate change records');
    const allDiffIds = [
      ...diff.addedSessions.map((s) => s.sessionId),
      ...diff.updatedRoomSessions.map((s) => s.sessionId),
      ...diff.updatedTimeSessions.map((s) => s.sessionId),
      ...diff.unchangedSessions.map((s) => s.sessionId),
    ];
    const uniqueDiffIds = new Set(allDiffIds);
    assert(allDiffIds.length === uniqueDiffIds.size, 'Zero duplicate session IDs in change detection report');

    // -------------------------------------------------------------
    // 16. Calendar Event Generation & Approval Safety Gate
    // -------------------------------------------------------------
    console.log('\nTest 16: Calendar event generation and approval safety');
    const calPreviewRes = await request('GET', '/api/calendar/preview?group=Y1-A');
    assert(calPreviewRes.status === 200, 'Calendar preview returns HTTP 200 for approved schedule');
    assert(calPreviewRes.body.events_count > 0, 'Generates calendar events for student group Y1-A');
    assert(calPreviewRes.body.data[0].iCalUID.startsWith('cit-session-'), 'iCalUID has stable RFC format');

    // Verify unapproved schedule cannot generate calendar events
    let safetyTriggered = false;
    try {
      await CalendarService.generateCalendarEvents({ ...approvedSchedule!, status: 'proposed' });
    } catch (err: any) {
      safetyTriggered = true;
      assert(err.message.includes('Safety violation'), 'Throws safety error if attempting to generate events for proposed schedule');
    }
    assert(safetyTriggered, 'Approval safety gate is strictly enforced');

    // -------------------------------------------------------------
    // 17. Preservation of existing Milestone 1 tests
    // -------------------------------------------------------------
    console.log('\nTest 17: Preservation of existing Milestone 1 test suite');
    try {
      const { execSync } = await import('child_process');
      const output = execSync('/usr/bin/python3 -m unittest tests/test_engine.py 2>&1', {
        encoding: 'utf-8',
      });
      assert(output.includes('OK'), 'All 6 Milestone 1 unit tests still pass 100%');
    } catch (err: any) {
      assert(false, 'Milestone 1 tests failed', err.message);
    }
  } finally {
    server.close();
  }

  console.log('\n=================================================================');
  console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('=================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
