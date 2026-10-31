-- ============================================================================
-- CIT CAMPUS SCHEDULING & VENUE MANAGEMENT - AUTHORITATIVE POSTGRESQL SCHEMA
-- Target Engine: PostgreSQL 14+ (Supabase / Neon / Cloud SQL Compatible)
-- Corrected for all 9 architectural & relational constraints verified against cit_public.json
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. DEPARTMENTS & INSTITUTIONAL MASTER (Defect 6: All 10 authoritative depts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    code VARCHAR(16) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed authoritative institutional departments from cit_public.json
INSERT INTO departments (code, name) VALUES
    ('ADMIN', 'Administration & Central Services'),
    ('CE', 'Department of Civil Engineering'),
    ('CSE', 'Department of Computer Science and Engineering'),
    ('ECE', 'Department of Electronics and Communication Engineering'),
    ('EE', 'Department of Electrical Engineering'),
    ('HSS', 'Department of Humanities and Social Sciences'),
    ('MA', 'Department of Mathematics'),
    ('ME', 'Department of Mechanical Engineering'),
    ('PH', 'Department of Physics'),
    ('COMMON', 'First Year Common Academic Curriculum')
ON CONFLICT (code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. USERS & RBAC PROFILES (5 Authoritative Roles)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY, -- e.g. "usr-admin", "usr-coord-cse", "usr-faculty-f19"
    username VARCHAR(64) NOT NULL UNIQUE,
    display_name VARCHAR(128) NOT NULL,
    email VARCHAR(128) NOT NULL UNIQUE,
    role VARCHAR(32) NOT NULL CHECK (role IN ('admin', 'department_coordinator', 'faculty', 'club', 'student')),
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
    department_code VARCHAR(16) REFERENCES departments(code) ON DELETE SET NULL,
    faculty_id VARCHAR(32), -- FK resolved after faculty table
    student_group_id VARCHAR(32), -- FK resolved after student_groups table
    club_name VARCHAR(128),
    password_hash VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_code);

CREATE TABLE IF NOT EXISTS user_auth_tokens (
    token VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_auth_tokens_user ON user_auth_tokens(user_id);

-- ----------------------------------------------------------------------------
-- 3. ROOMS & FACILITIES (Defect 4: Exactly 10 Authoritative Room Types)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
    id VARCHAR(32) PRIMARY KEY, -- e.g. 'AUD', 'CR-101', 'LH-1'
    name VARCHAR(128) NOT NULL,
    building VARCHAR(64) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (
        type IN (
            'classroom',
            'lecture_hall',
            'seminar_hall',
            'auditorium',
            'outdoor',
            'lab_cs',
            'lab_elec',
            'lab_phy',
            'workshop',
            'lab_civil'
        )
    ),
    capacity INT NOT NULL CHECK (capacity > 0),
    accessible BOOLEAN NOT NULL DEFAULT FALSE,
    features JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_uses JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rooms_type ON rooms(type);
CREATE INDEX IF NOT EXISTS idx_rooms_capacity ON rooms(capacity);

CREATE TABLE IF NOT EXISTS room_unavailability (
    id SERIAL PRIMARY KEY,
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')),
    period INT NOT NULL CHECK (period BETWEEN 1 AND 13),
    reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_unavail_room_day ON room_unavailability(room_id, day);

-- ----------------------------------------------------------------------------
-- 4. FACULTY & STUDENT GROUPS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faculty (
    id VARCHAR(32) PRIMARY KEY, -- e.g. 'F01', 'F19'
    name VARCHAR(128) NOT NULL,
    department_code VARCHAR(16) NOT NULL REFERENCES departments(code),
    max_hours_per_day INT NOT NULL DEFAULT 4 CHECK (max_hours_per_day BETWEEN 1 AND 9),
    needs_accessible BOOLEAN NOT NULL DEFAULT FALSE,
    preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_faculty_department ON faculty(department_code);

CREATE TABLE IF NOT EXISTS faculty_unavailability (
    id SERIAL PRIMARY KEY,
    faculty_id VARCHAR(32) NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')),
    period INT NOT NULL CHECK (period BETWEEN 1 AND 13),
    reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_faculty_unavail_day ON faculty_unavailability(faculty_id, day);

CREATE TABLE IF NOT EXISTS student_groups (
    id VARCHAR(32) PRIMARY KEY, -- e.g. 'Y1-A', 'CSE-3'
    name VARCHAR(128) NOT NULL,
    year INT NOT NULL CHECK (year BETWEEN 1 AND 4),
    department_code VARCHAR(16) NOT NULL REFERENCES departments(code),
    size INT NOT NULL CHECK (size > 0),
    needs_accessible BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_groups_dept ON student_groups(department_code);
CREATE INDEX IF NOT EXISTS idx_student_groups_year ON student_groups(year);

-- Add deferred foreign keys to users table
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS fk_users_faculty,
    ADD CONSTRAINT fk_users_faculty FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS fk_users_student_group,
    ADD CONSTRAINT fk_users_student_group FOREIGN KEY (student_group_id) REFERENCES student_groups(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- 5. COURSES & SESSIONS (Defect 1: 1NF Multi-Group & Defect 5: Academic Hours)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
    id VARCHAR(32) PRIMARY KEY, -- e.g. 'MA101', 'CS201'
    title VARCHAR(255) NOT NULL,
    department_code VARCHAR(16) NOT NULL REFERENCES departments(code),
    year INT NOT NULL CHECK (year BETWEEN 1 AND 4),
    lecture_hours INT NOT NULL DEFAULT 0 CHECK (lecture_hours >= 0),
    tutorial_hours INT NOT NULL DEFAULT 0 CHECK (tutorial_hours >= 0),
    lab_blocks INT NOT NULL DEFAULT 0 CHECK (lab_blocks >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_courses_dept ON courses(department_code);
CREATE INDEX IF NOT EXISTS idx_courses_year ON courses(year);

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY, -- e.g. 'MA101-AB-L1'
    course_id VARCHAR(32) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('lecture', 'tutorial', 'lab')),
    faculty_id VARCHAR(32) NOT NULL REFERENCES faculty(id),
    size INT NOT NULL CHECK (size > 0),
    duration INT NOT NULL CHECK (duration BETWEEN 1 AND 4),
    needs_accessible BOOLEAN NOT NULL DEFAULT FALSE,
    basket_slot VARCHAR(32),
    fixed_slot VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(course_id);
CREATE INDEX IF NOT EXISTS idx_sessions_faculty ON sessions(faculty_id);

-- DEFECT 1 RESOLUTION: 1NF Normalized Session Groups join table (Multi-Group sessions)
CREATE TABLE IF NOT EXISTS session_groups (
    session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    group_id VARCHAR(32) NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_session_groups_group ON session_groups(group_id);

CREATE TABLE IF NOT EXISTS session_room_types (
    session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    room_type VARCHAR(32) NOT NULL CHECK (
        room_type IN (
            'classroom',
            'lecture_hall',
            'seminar_hall',
            'auditorium',
            'outdoor',
            'lab_cs',
            'lab_elec',
            'lab_phy',
            'workshop',
            'lab_civil'
        )
    ),
    PRIMARY KEY (session_id, room_type)
);

-- ----------------------------------------------------------------------------
-- 6. SCHEDULE VERSIONS & TIMETABLE ALLOCATIONS (Defect 3 & Defect 8)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_versions (
    id VARCHAR(64) PRIMARY KEY, -- e.g. 'v1', 'v2-disruption'
    name VARCHAR(255) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('approved', 'proposed', 'archived', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(64) NOT NULL REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    approved_by VARCHAR(64) REFERENCES users(id),
    dataset_id VARCHAR(64) NOT NULL DEFAULT 'cit-public-v1',
    team VARCHAR(128) NOT NULL DEFAULT 'CIT Arch Team',
    disruption_id VARCHAR(64),
    validator_report JSONB
);

-- DEFECT 8 RESOLUTION: Only ONE approved master schedule version allowed at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_approved_schedule
    ON schedule_versions(status)
    WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_schedule_versions_status ON schedule_versions(status);

-- Timetable teaching session allocations
CREATE TABLE IF NOT EXISTS scheduled_sessions (
    id SERIAL PRIMARY KEY,
    schedule_version_id VARCHAR(64) NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
    session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI')), -- Defect 3: Mon-Fri for teaching
    start_period INT NOT NULL CHECK (start_period BETWEEN 1 AND 9), -- Defect 3: Teaching periods 1-9
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id),
    UNIQUE (schedule_version_id, session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_sess_no_double_book ON scheduled_sessions(schedule_version_id, day, start_period, room_id);
CREATE INDEX IF NOT EXISTS idx_sched_sess_lookup ON scheduled_sessions(schedule_version_id, day, start_period, room_id);

-- ----------------------------------------------------------------------------
-- 7. EXAMINATIONS & EXAM SCHEDULES (Defect 2 & Defect 3: Multi-Room & Days)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exams (
    id VARCHAR(64) PRIMARY KEY, -- e.g. 'EX-MA101'
    size INT NOT NULL CHECK (size > 0),
    duration_hours INT NOT NULL CHECK (duration_hours > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_courses (
    exam_id VARCHAR(64) NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    course_id VARCHAR(32) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    PRIMARY KEY (exam_id, course_id)
);

CREATE TABLE IF NOT EXISTS exam_groups (
    exam_id VARCHAR(64) NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    group_id VARCHAR(32) NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (exam_id, group_id)
);

-- DEFECT 2 & 3 RESOLUTION: Normalized exam schedule slot and multi-room assignment
CREATE TABLE IF NOT EXISTS exam_schedules (
    id SERIAL PRIMARY KEY,
    schedule_version_id VARCHAR(64) NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
    exam_id VARCHAR(64) NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT')), -- Exam days Mon-Sat
    session_slot VARCHAR(2) NOT NULL CHECK (session_slot IN ('AM', 'PM')),
    UNIQUE (schedule_version_id, exam_id)
);

CREATE TABLE IF NOT EXISTS exam_schedule_rooms (
    exam_schedule_id INT NOT NULL REFERENCES exam_schedules(id) ON DELETE CASCADE,
    room_id VARCHAR(32) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    PRIMARY KEY (exam_schedule_id, room_id)
);

-- ----------------------------------------------------------------------------
-- 8. VENUE BOOKINGS & SELF-APPROVAL TRIGGER (Defect 7 & Defect 9)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venue_bookings (
    id VARCHAR(64) PRIMARY KEY, -- e.g. 'BR-01'
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requester VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('admin', 'department_coordinator', 'faculty', 'club')),
    requested_category VARCHAR(64) NOT NULL,
    effective_category VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    attendance INT NOT NULL CHECK (attendance > 0),
    duration_periods INT NOT NULL CHECK (duration_periods BETWEEN 1 AND 13),
    requested_room VARCHAR(32) REFERENCES rooms(id) ON DELETE SET NULL,
    raw_text TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'alternative_offered')),
    allocated_room VARCHAR(32) REFERENCES rooms(id) ON DELETE SET NULL,
    allocated_day VARCHAR(3) CHECK (allocated_day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')),
    allocated_start_period INT CHECK (allocated_start_period BETWEEN 1 AND 13),
    allocated_end_period INT CHECK (allocated_end_period BETWEEN 1 AND 13),
    decision_reason TEXT,
    created_by VARCHAR(64) NOT NULL REFERENCES users(id),
    decided_by VARCHAR(64) REFERENCES users(id),
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON venue_bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created_by ON venue_bookings(created_by);

-- DEFECT 9 RESOLUTION: Normalized booking windows table with period constraints
CREATE TABLE IF NOT EXISTS booking_windows (
    id SERIAL PRIMARY KEY,
    booking_id VARCHAR(64) NOT NULL REFERENCES venue_bookings(id) ON DELETE CASCADE,
    day VARCHAR(3) NOT NULL CHECK (day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')),
    from_period INT NOT NULL CHECK (from_period BETWEEN 1 AND 13),
    to_period INT NOT NULL CHECK (to_period BETWEEN 1 AND 13),
    CONSTRAINT chk_window_order CHECK (from_period <= to_period)
);

CREATE INDEX IF NOT EXISTS idx_booking_windows_lookup ON booking_windows(booking_id, day);

CREATE TABLE IF NOT EXISTS booking_room_types (
    booking_id VARCHAR(64) NOT NULL REFERENCES venue_bookings(id) ON DELETE CASCADE,
    room_type VARCHAR(32) NOT NULL CHECK (
        room_type IN (
            'classroom',
            'lecture_hall',
            'seminar_hall',
            'auditorium',
            'outdoor',
            'lab_cs',
            'lab_elec',
            'lab_phy',
            'workshop',
            'lab_civil'
        )
    ),
    PRIMARY KEY (booking_id, room_type)
);

CREATE TABLE IF NOT EXISTS booking_needs (
    booking_id VARCHAR(64) NOT NULL REFERENCES venue_bookings(id) ON DELETE CASCADE,
    need_tag VARCHAR(64) NOT NULL,
    PRIMARY KEY (booking_id, need_tag)
);

CREATE TABLE IF NOT EXISTS booking_mandatory_groups (
    booking_id VARCHAR(64) NOT NULL REFERENCES venue_bookings(id) ON DELETE CASCADE,
    group_id VARCHAR(32) NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (booking_id, group_id)
);

-- DEFECT 7 RESOLUTION: Database trigger preventing self-approval
CREATE OR REPLACE FUNCTION trg_check_no_self_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('approved', 'rejected') AND NEW.decided_by IS NOT NULL THEN
        IF NEW.decided_by = NEW.created_by THEN
            RAISE EXCEPTION 'Self-approval violation: Users cannot approve or reject their own bookings (user: %, booking: %)',
                NEW.decided_by, NEW.id
                USING ERRCODE = '23514'; -- check_violation
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_booking_no_self_approval ON venue_bookings;
CREATE TRIGGER trg_venue_booking_no_self_approval
BEFORE UPDATE ON venue_bookings
FOR EACH ROW
EXECUTE FUNCTION trg_check_no_self_approval();

-- Trigger preventing self-approval on schedule_versions
CREATE OR REPLACE FUNCTION trg_check_schedule_no_self_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'approved' AND NEW.approved_by IS NOT NULL THEN
        IF NEW.approved_by = NEW.created_by THEN
            RAISE EXCEPTION 'Self-approval violation: Users cannot approve their own schedule version (user: %, schedule: %)',
                NEW.approved_by, NEW.id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_schedule_version_no_self_approval ON schedule_versions;
CREATE TRIGGER trg_schedule_version_no_self_approval
BEFORE UPDATE ON schedule_versions
FOR EACH ROW
EXECUTE FUNCTION trg_check_schedule_no_self_approval();

-- ----------------------------------------------------------------------------
-- 9. DISRUPTIONS & AUDIT LOGS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disruptions (
    id VARCHAR(64) PRIMARY KEY, -- e.g. 'disruption-sample'
    title VARCHAR(255) NOT NULL,
    description TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_by VARCHAR(64) NOT NULL REFERENCES users(id),
    status VARCHAR(16) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
    changes JSONB NOT NULL DEFAULT '[]'::jsonb,
    proposed_schedule_version_id VARCHAR(64) REFERENCES schedule_versions(id) ON DELETE SET NULL,
    stability_metrics JSONB,
    validator_report JSONB,
    approved_by VARCHAR(64) REFERENCES users(id),
    approved_at TIMESTAMPTZ
);

-- Trigger preventing self-approval on disruptions
CREATE OR REPLACE FUNCTION trg_check_disruption_no_self_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('approved', 'rejected') AND NEW.approved_by IS NOT NULL THEN
        IF NEW.approved_by = NEW.submitted_by THEN
            RAISE EXCEPTION 'Self-approval violation: Users cannot approve or reject their own disruptions (user: %, disruption: %)',
                NEW.approved_by, NEW.id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_disruption_no_self_approval ON disruptions;
CREATE TRIGGER trg_disruption_no_self_approval
BEFORE UPDATE ON disruptions
FOR EACH ROW
EXECUTE FUNCTION trg_check_disruption_no_self_approval();

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id VARCHAR(64) NOT NULL REFERENCES users(id),
    user_name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL,
    action VARCHAR(128) NOT NULL,
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(128),
    details JSONB,
    status VARCHAR(16) NOT NULL CHECK (status IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- ----------------------------------------------------------------------------
-- 10. CALENDAR INTEGRATION METADATA
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_connections (
    user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    calendar_id VARCHAR(255) NOT NULL,
    sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calendar_event_mappings (
    id SERIAL PRIMARY KEY,
    schedule_version_id VARCHAR(64) NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
    event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('session', 'booking', 'exam')),
    local_id VARCHAR(64) NOT NULL,
    google_event_id VARCHAR(255) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (schedule_version_id, event_type, local_id)
);
