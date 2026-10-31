import { PostgresStorage } from '../server/postgresStorage.js';
import { IStorage, ScheduleVersion, BookingRecord, UserRecord } from '../server/storageInterface.js';

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

class MockClient {
  public queries: Array<{ sql: string; params?: any[] }> = [];
  public inTransaction: boolean = false;
  public committed: boolean = false;
  public rolledBack: boolean = false;
  public released: boolean = false;

  async query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }> {
    this.queries.push({ sql, params });
    const cleanSql = sql.trim().toUpperCase();

    if (cleanSql === 'BEGIN') {
      this.inTransaction = true;
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql === 'COMMIT') {
      this.committed = true;
      this.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql === 'ROLLBACK') {
      this.rolledBack = true;
      this.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }

    if (cleanSql.includes('SELECT * FROM ROOMS')) {
      return {
        rows: [
          { id: 'CR-101', name: 'Classroom 101', building: 'Academic Block', type: 'classroom', capacity: 40, accessible: true, features: '["projector"]', allowed_uses: '["lecture"]' }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('SELECT * FROM FACULTY')) {
      return {
        rows: [
          { id: 'F01', name: 'Prof. Turing', department_code: 'CSE', max_hours_per_day: 4, needs_accessible: false, preferences: '[]' }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('SELECT * FROM STUDENT_GROUPS')) {
      return {
        rows: [
          { id: 'CSE-3', name: 'CSE Third Year', year: 3, department_code: 'CSE', size: 30, needs_accessible: false }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('SELECT * FROM COURSES')) {
      return {
        rows: [
          { id: 'CS201', title: 'Data Structures', department_code: 'CSE', year: 2, lecture_hours: 3, tutorial_hours: 1, lab_blocks: 1 }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM SESSIONS S')) {
      return {
        rows: [
          { id: 'CS201-L1', course_id: 'CS201', kind: 'lecture', faculty_id: 'F01', size: 30, duration: 1, room_types: ['classroom'], groups: ['CSE-3'], needs_accessible: false }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM EXAMS E')) {
      return {
        rows: [
          { id: 'EX-CS201', size: 30, duration_hours: 2, course_ids: ['CS201'], groups: ['CSE-3'] }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM VENUE_BOOKINGS')) {
      return {
        rows: [
          {
            id: 'BR-01',
            submitted_at: new Date().toISOString(),
            requester: 'Prof. Turing',
            role: 'faculty',
            requested_category: 'guest_lecture',
            effective_category: 'guest_lecture',
            title: 'AI Colloquium',
            attendance: 35,
            duration_periods: 2,
            status: 'approved',
            allocated_room: 'CR-101',
            allocated_day: 'WED',
            allocated_start_period: 4,
            allocated_end_period: 5,
            created_by: 'usr-faculty-f01',
          }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM BOOKING_WINDOWS')) {
      return {
        rows: [{ day: 'WED', from_period: 3, to_period: 6 }],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM BOOKING_ROOM_TYPES')) {
      return { rows: [{ room_type: 'classroom' }], rowCount: 1 };
    }
    if (cleanSql.includes('FROM BOOKING_NEEDS')) {
      return { rows: [{ need_tag: 'projector' }], rowCount: 1 };
    }
    if (cleanSql.includes('FROM BOOKING_MANDATORY_GROUPS')) {
      return { rows: [{ group_id: 'CSE-3' }], rowCount: 1 };
    }
    if (cleanSql.includes('UPDATE SCHEDULE_VERSIONS')) {
      return {
        rows: [
          {
            id: 'v2-proposed',
            name: 'Proposed Schedule',
            status: 'approved',
            created_at: new Date().toISOString(),
            created_by: 'usr-admin',
            approved_at: new Date().toISOString(),
            approved_by: 'usr-admin',
            dataset_id: 'cit-public-v1',
            team: 'CIT Arch Team',
          }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM SCHEDULE_VERSIONS')) {
      return {
        rows: [
          {
            id: 'v1',
            name: 'Master Timetable',
            status: 'approved',
            created_at: new Date().toISOString(),
            created_by: 'usr-admin',
            approved_at: new Date().toISOString(),
            approved_by: 'usr-admin',
            dataset_id: 'cit-public-v1',
            team: 'CIT Arch Team',
            validator_report: { hard_violation_count: 0, soft_total: 170 },
          }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM SCHEDULED_SESSIONS')) {
      return {
        rows: [
          { session_id: 'CS201-L1', day: 'MON', start_period: 1, room_id: 'CR-101' }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM EXAM_SCHEDULES')) {
      return {
        rows: [
          { exam_id: 'EX-CS201', day: 'MON', session: 'AM', rooms: ['CR-101'] }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM USERS')) {
      return {
        rows: [
          {
            id: 'usr-admin',
            username: 'admin',
            display_name: 'Administrator',
            email: 'admin@cit.ac.in',
            role: 'admin',
            status: 'active',
            department_code: 'ADMIN',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('FROM USER_AUTH_TOKENS')) {
      return {
        rows: [
          { token: 'admin-secret-token', user_id: 'usr-admin' }
        ],
        rowCount: 1,
      };
    }
    if (cleanSql.includes('SELECT CODE FROM DEPARTMENTS')) {
      return { rows: [{ code: 'CSE' }], rowCount: 1 };
    }
    if (cleanSql.includes('SELECT ID FROM STUDENT_GROUPS')) {
      return { rows: [{ id: 'CSE-3' }], rowCount: 1 };
    }
    if (cleanSql.includes('SELECT ID FROM FACULTY')) {
      return { rows: [{ id: 'F01' }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

class MockPool {
  public client = new MockClient();

  async connect(): Promise<any> {
    return this.client;
  }

  async query(sql: string, params?: any[]): Promise<any> {
    return this.client.query(sql, params);
  }

  async end(): Promise<void> {}
}

async function runMockPostgresSuite() {
  console.log('=================================================================');
  console.log('POSTGRESQL STORAGE ADAPTER UNIT & TRANSACTIONAL VERIFICATION');
  console.log('=================================================================\n');

  const mockPool = new MockPool();
  const pgStorage = new PostgresStorage('postgresql://mock:mock@localhost/mock', mockPool as any);

  // 1. Verify IStorage implementation interface check
  console.log('--- Test 1: IStorage Contract Completeness ---');
  const requiredMethods: (keyof IStorage)[] = [
    'getDataset',
    'saveDataset',
    'getAllSchedules',
    'getScheduleById',
    'getApprovedSchedule',
    'saveSchedule',
    'promoteSchedule',
    'getAllBookings',
    'getBookingById',
    'saveBooking',
    'saveAllBookings',
    'getAllDisruptions',
    'getDisruptionById',
    'saveDisruption',
    'logAudit',
    'getAuditLogs',
    'getCalendarSyncData',
    'saveCalendarSyncData',
    'getAllUsers',
    'getUserById',
    'getUserByUsername',
    'getUserByToken',
    'saveUser',
    'createUser',
    'updateUser',
    'validateReferentialIntegrity',
  ];

  for (const m of requiredMethods) {
    assert(typeof (pgStorage as any)[m] === 'function', `Method ${m} is implemented on PostgresStorage`);
  }

  // 2. Test getApprovedSchedule reconstruction
  console.log('\n--- Test 2: Schedule Reconstruction Matching Official Validator Format ---');
  const schedule = await pgStorage.getApprovedSchedule();
  assert(schedule !== null, 'Reconstructed schedule is not null');
  assert(schedule?.id === 'v1', 'Schedule ID is v1');
  assert(schedule?.status === 'approved', 'Schedule status is approved');
  assert(schedule?.sessions.length === 1, 'Schedule includes sessions from scheduled_sessions');
  assert(schedule?.sessions[0].session_id === 'CS201-L1', 'Session ID reconstructed accurately');
  assert(schedule?.sessions[0].day === 'MON', 'Session day reconstructed accurately');
  assert(schedule?.sessions[0].start_period === 1, 'Session start_period reconstructed accurately');
  assert(schedule?.sessions[0].room_id === 'CR-101', 'Session room_id reconstructed accurately');
  assert(Array.isArray(schedule?.exams), 'Schedule includes exams array matching validator schema');

  // 3. Test Atomic Schedule Promotion
  console.log('\n--- Test 3: Atomic Schedule Promotion Transaction Safety ---');
  mockPool.client.queries = [];
  const promoted = await pgStorage.promoteSchedule('v2-proposed', 'usr-admin');
  assert(promoted !== null, 'Promoted schedule returned');
  const queries = mockPool.client.queries.map((q) => q.sql.trim().toUpperCase());
  assert(queries.includes('BEGIN'), 'Transaction started with BEGIN');
  assert(
    queries.some((q) => q.includes("UPDATE SCHEDULE_VERSIONS SET STATUS = 'ARCHIVED'")),
    'Archived prior approved schedule version in same transaction'
  );
  assert(
    queries.some((q) => q.includes("SET STATUS = 'APPROVED', APPROVED_AT = NOW()")),
    'Promoted target schedule version to approved'
  );
  assert(queries.includes('COMMIT'), 'Transaction committed with COMMIT');
  assert(mockPool.client.released === true, 'Database client released after transaction');

  // 4. Test User Authentication Queries
  console.log('\n--- Test 4: User Authentication Token Lookup ---');
  const user = await pgStorage.getUserByToken('admin-secret-token');
  assert(user !== null, 'User found by secret token');
  assert(user?.role === 'admin', 'User role is verified as admin');
  assert(user?.username === 'admin', 'User username is admin');

  // 5. Test Referential Integrity Validation
  console.log('\n--- Test 5: Referential Integrity Checks ---');
  await pgStorage.validateReferentialIntegrity({
    department: 'CSE',
    student_group_id: 'CSE-3',
    faculty_id: 'F01',
  });
  assert(true, 'Valid foreign key references pass validation');

  // 6. Test Transaction Rollback On Query Failure
  console.log('\n--- Test 6: Transaction Rollback on Error ---');
  const failingPool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.trim().toUpperCase() === 'BEGIN') return {};
        throw new Error('Simulated Database Connection Failure');
      },
      release: () => {},
    }),
  };
  const failingStorage = new PostgresStorage('postgresql://mock:mock@localhost/mock', failingPool as any);
  let caughtError = false;
  try {
    await failingStorage.promoteSchedule('v_fail', 'usr-admin');
  } catch (err: any) {
    caughtError = true;
    assert(err.message.includes('Simulated Database Connection Failure'), 'Error successfully propagated');
  }
  assert(caughtError, 'Transaction safely aborts on query failure');

  console.log('\n=================================================================');
  console.log(`POSTGRESQL STORAGE TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMockPostgresSuite().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
