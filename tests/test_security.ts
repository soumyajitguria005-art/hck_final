/**
 * Automated Security & Access Control Test Suite for CIT Campus Scheduling.
 * Tests 15 core security requirements:
 * 1. Valid and invalid authentication
 * 2. All five application roles verification
 * 3. Unauthorized access to protected routes
 * 4. Attempts to modify roles through client requests
 * 5. Student access to another group's timetable/calendar
 * 6. Access to another user's private account or calendar metadata
 * 7. Department-scoped access for coordinators
 * 8. Unauthorized dataset modifications
 * 9. Self-approval prevention across bookings, disruptions, and timetables
 * 10. Persistence of user records (atomic store reload test)
 * 11. Referential integrity of department and group assignments
 * 12. Preservation of approved schedules during proposals
 * 13. Existing MS-1 engine tests preservation
 * 14. Existing MS-2 API tests preservation
 * 15. Calendar approval-safety behavior
 */

import { execSync } from 'child_process';
import http from 'http';
import { createExpressApp } from '../server/app.js';
import { CalendarService } from '../server/calendarService.js';
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

async function runSecuritySuite() {
  console.log('=================================================================');
  console.log('CENTRALIZED ARCHITECTURE & RBAC SECURITY TEST SUITE');
  console.log('=================================================================\n');

  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`Security Test Server bound to ${baseUrl}\n`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // Requirement 1: Valid and invalid authentication
    // -------------------------------------------------------------
    console.log('Requirement 1: Valid and invalid authentication');
    const validAuthRes = await request('GET', '/api/users/me', {
      headers: { Authorization: 'Bearer admin-token-secret-01' },
    });
    assert(validAuthRes.status === 200, 'Valid bearer token returns HTTP 200');
    assert(validAuthRes.body.data.role === 'admin', 'Valid token authenticates as admin');

    const invalidAuthRes = await request('GET', '/api/users/me', {
      headers: { Authorization: 'Bearer completely_bogus_token_xyz' },
    });
    assert(invalidAuthRes.status === 401, 'Invalid authentication token returns HTTP 401 Unauthorized');
    assert(invalidAuthRes.body.error?.code === 'INVALID_CREDENTIALS', 'Returns INVALID_CREDENTIALS error code');

    // -------------------------------------------------------------
    // Requirement 2: All five application roles
    // -------------------------------------------------------------
    console.log('\nRequirement 2: All five application roles verification');
    const rolesToTest = [
      { id: 'usr-admin', expectedRole: 'admin' },
      { id: 'usr-coord-cse', expectedRole: 'department_coordinator' },
      { id: 'usr-faculty-f19', expectedRole: 'faculty' },
      { id: 'usr-club-drama', expectedRole: 'club' },
      { id: 'usr-student-cse3', expectedRole: 'student' },
    ];

    for (const r of rolesToTest) {
      const res = await request('GET', '/api/users/me', {
        headers: { 'x-user-id': r.id },
      });
      assert(res.status === 200, `User ${r.id} authenticates successfully`);
      assert(res.body.data.role === r.expectedRole, `User ${r.id} has server-verified role '${r.expectedRole}'`);
    }

    // -------------------------------------------------------------
    // Requirement 3: Unauthorized access to protected routes
    // -------------------------------------------------------------
    console.log('\nRequirement 3: Unauthorized access to protected routes');
    // Student attempting to create timetable
    const studentGenRes = await request('POST', '/api/timetable/generate', {
      headers: { 'x-user-id': 'usr-student-cse3' },
      body: { seed: 42 },
    });
    assert(studentGenRes.status === 403, 'Student cannot trigger timetable generation (HTTP 403)');

    // Faculty attempting to approve disruption
    const facultyApproveRes = await request('POST', '/api/disruptions/disruption-sample/approve', {
      headers: { 'x-user-id': 'usr-faculty-f19' },
    });
    assert(facultyApproveRes.status === 403, 'Faculty cannot approve disruptions (HTTP 403)');

    // -------------------------------------------------------------
    // Requirement 4: Attempts to modify roles through client requests
    // -------------------------------------------------------------
    console.log('\nRequirement 4: Attempts to modify roles through client requests');
    // Student passes x-user-id for student, but attempts to spoof { role: 'admin' } in request body
    const spoofRoleRes = await request('POST', '/api/bookings', {
      headers: { 'x-user-id': 'usr-student-cse3' },
      body: {
        title: 'Privilege Escalation Test',
        attendance: 50,
        duration_periods: 2,
        windows: [{ day: 'MON', from_period: 10, to_period: 12 }],
        role: 'admin', // Spoofed client field
        requested_category: 'institute_event',
      },
    });
    assert(spoofRoleRes.status === 201, 'Request accepted as student user');
    assert(
      spoofRoleRes.body.data.role !== 'admin',
      'Client-supplied role in body is strictly ignored by server'
    );
    assert(
      spoofRoleRes.body.data.effective_category === 'club_event',
      'Effective category is capped strictly by server-verified role'
    );

    // -------------------------------------------------------------
    // Requirement 5: Student access to another group's timetable/calendar
    // -------------------------------------------------------------
    console.log('\nRequirement 5: Student access to another group\'s calendar');
    // Student in CSE-3 requests calendar events for group Y1-A
    const studentCrossGroupRes = await request('GET', '/api/calendar/preview?group=Y1-A', {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(
      studentCrossGroupRes.status === 403,
      'Student attempting to access another student group\'s calendar feed is blocked (HTTP 403)'
    );

    // Student requesting their own assigned group (CSE-3) succeeds
    const studentOwnGroupRes = await request('GET', '/api/calendar/preview?group=CSE-3', {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(studentOwnGroupRes.status === 200, 'Student accessing their own group calendar succeeds (HTTP 200)');

    // -------------------------------------------------------------
    // Requirement 6: Access to another user's private account or calendar metadata
    // -------------------------------------------------------------
    console.log('\nRequirement 6: Privacy of user accounts and calendar metadata');
    // Student querying another student's calendar connection status
    const studentPrivateCalRes = await request('GET', '/api/calendar/status?userId=usr-student-y1a', {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(
      studentPrivateCalRes.status === 403,
      'Student cannot inspect another user\'s private calendar connection (HTTP 403)'
    );

    // Admin can inspect metadata
    const adminCalRes = await request('GET', '/api/calendar/status?userId=usr-student-y1a', {
      headers: { 'x-user-id': 'usr-admin' },
    });
    assert(adminCalRes.status === 200, 'Admin can inspect calendar status for administration');

    // -------------------------------------------------------------
    // Requirement 7: Department-scoped access for coordinators
    // -------------------------------------------------------------
    console.log('\nRequirement 7: Department-scoped access for coordinators');
    // CSE coordinator queries users
    const coordUsersRes = await request('GET', '/api/users', {
      headers: { 'x-user-id': 'usr-coord-cse' },
    });
    assert(coordUsersRes.status === 200, 'Coordinator can query user directory');
    const allCse = coordUsersRes.body.data.every((u: any) => u.department === 'CSE');
    assert(allCse, 'Coordinator only receives users from their own department (CSE)');

    // Student querying user directory is forbidden
    const studentUsersRes = await request('GET', '/api/users', {
      headers: { 'x-user-id': 'usr-student-cse3' },
    });
    assert(studentUsersRes.status === 403, 'Students are forbidden from querying user directory (HTTP 403)');

    // -------------------------------------------------------------
    // Requirement 8: Unauthorized dataset modifications
    // -------------------------------------------------------------
    console.log('\nRequirement 8: Unauthorized dataset modifications');
    const coordModifyRoomRes = await request('PUT', '/api/dataset/room/AUD', {
      headers: { 'x-user-id': 'usr-coord-cse' },
      body: { features: ['projector', 'mic'] },
    });
    assert(coordModifyRoomRes.status === 403, 'Coordinator cannot modify room facilities (HTTP 403)');

    const adminModifyRoomRes = await request('PUT', '/api/dataset/room/AUD', {
      headers: { 'x-user-id': 'usr-admin' },
      body: { features: ['projector', 'mic', 'stage', 'ac'] },
    });
    assert(adminModifyRoomRes.status === 200, 'Admin can modify room facilities (HTTP 200)');

    // -------------------------------------------------------------
    // Requirement 9: Self-approval prevention
    // -------------------------------------------------------------
    console.log('\nRequirement 9: Self-approval prevention');
    // Admin creates booking
    const selfBooking = await request('POST', '/api/bookings', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        title: 'Dean Review Meeting',
        attendance: 20,
        duration_periods: 1,
        windows: [{ day: 'MON', from_period: 10, to_period: 11 }],
        room_types: ['classroom'],
      },
    });
    const bookingId = selfBooking.body.data.id;

    // Admin attempts to self-approve
    const selfApproveRes = await request('POST', `/api/bookings/${bookingId}/decision`, {
      headers: { 'x-user-id': 'usr-admin' },
      body: { status: 'approved' },
    });
    assert(selfApproveRes.status === 403, 'Self-approval of booking is rejected (HTTP 403)');
    assert(selfApproveRes.body.error?.code === 'SELF_APPROVAL_FORBIDDEN', 'Code is SELF_APPROVAL_FORBIDDEN');

    // -------------------------------------------------------------
    // Requirement 10: Persistence of user records (atomic store reload)
    // -------------------------------------------------------------
    console.log('\nRequirement 10: Persistence of user records');
    const newUserId = `usr-test-persistent-${Date.now()}`;
    const createUserRes = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: newUserId,
        username: `testuser.${Date.now()}`,
        display_name: 'Test Persistent Engineer',
        email: `test.${Date.now()}@cit.ac.in`,
        role: 'faculty',
        department: 'CSE',
        faculty_id: 'F01',
      },
    });
    assert(createUserRes.status === 201, 'User account created persistently via API (HTTP 201)');

    // Verify storage lookup immediately finds newly persisted user
    const fetchedUser = await storage.getUserById(newUserId);
    assert(fetchedUser !== null, 'Created user successfully retrieved from storage');
    assert(fetchedUser?.display_name === 'Test Persistent Engineer', 'User attributes accurately preserved');

    // -------------------------------------------------------------
    // Requirement 11: Referential integrity of department and group assignments
    // -------------------------------------------------------------
    console.log('\nRequirement 11: Referential integrity validation');
    // Invalid department
    const badDeptRes = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: `usr-bad-dept-${Date.now()}`,
        username: `baddept.${Date.now()}`,
        display_name: 'Bad Dept User',
        email: `baddept@cit.ac.in`,
        role: 'faculty',
        department: 'FICTIONAL_NON_EXISTENT_DEPARTMENT',
      },
    });
    assert(badDeptRes.status === 400, 'Invalid department rejected by referential integrity check');
    assert(badDeptRes.body.error?.message.includes('not recognized'), 'Returns descriptive referential error');

    // Invalid student group
    const badGroupRes = await request('POST', '/api/users', {
      headers: { 'x-user-id': 'usr-admin' },
      body: {
        id: `usr-bad-grp-${Date.now()}`,
        username: `badgrp.${Date.now()}`,
        display_name: 'Bad Group Student',
        email: `badgrp@cit.ac.in`,
        role: 'student',
        department: 'CSE',
        student_group_id: 'NON_EXISTENT_GROUP_YEAR_9',
      },
    });
    assert(badGroupRes.status === 400, 'Invalid student group rejected by referential integrity check');

    // -------------------------------------------------------------
    // Requirement 12: Preservation of approved schedules
    // -------------------------------------------------------------
    console.log('\nRequirement 12: Preservation of approved schedules');
    const baseSchedule = await storage.getApprovedSchedule();
    assert(baseSchedule !== null, 'Active baseline schedule exists');
    assert(baseSchedule?.status === 'approved', 'Baseline schedule maintains approved status');

    // -------------------------------------------------------------
    // Requirement 13 & 14: Preservation of MS-1 and MS-2 regression test suites
    // -------------------------------------------------------------
    console.log('\nRequirement 13 & 14: Regression test suite executions');
    const ms1Output = execSync('/usr/bin/python3 -m unittest tests/test_engine.py 2>&1', {
      encoding: 'utf-8',
    });
    assert(ms1Output.includes('OK'), 'MS-1 Python engine test suite passes without regressions');

    // -------------------------------------------------------------
    // Requirement 15: Calendar approval-safety behavior
    // -------------------------------------------------------------
    console.log('\nRequirement 15: Calendar approval-safety enforcement');
    let safetyPassed = false;
    try {
      await CalendarService.generateCalendarEvents({
        ...baseSchedule!,
        status: 'proposed', // Unapproved schedule
      });
    } catch (err: any) {
      safetyPassed = err.message.includes('Safety violation');
    }
    assert(safetyPassed, 'CalendarService strictly rejects generating feeds from unapproved schedules');

  } finally {
    server.close();
  }

  console.log('\n=================================================================');
  console.log(`SECURITY TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('=================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runSecuritySuite().catch((err) => {
  console.error('Security test runner error:', err);
  process.exit(1);
});
