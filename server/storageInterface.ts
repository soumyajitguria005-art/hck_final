import { UserRole } from './auth.js';

export interface ScheduleVersion {
  id: string; // e.g. "v1", "v2-disruption"
  name: string;
  status: 'approved' | 'proposed' | 'archived' | 'rejected';
  created_at: string;
  created_by: string;
  approved_at?: string;
  approved_by?: string;
  dataset_id: string;
  team: string;
  disruption_id?: string;
  sessions: Array<{
    session_id: string;
    day: string;
    start_period: number;
    room_id: string;
  }>;
  fest_week?: {
    bookings: Array<{
      request_id: string;
      status: string;
      day?: string;
      start_period?: number;
      end_period?: number;
      room_id?: string;
      reason?: string;
    }>;
    session_overrides?: Array<{
      session_id: string;
      day: string;
      start_period: number;
      room_id: string;
      displaced_by: string;
    }>;
  };
  exams?: Array<{
    exam_id: string;
    day: string;
    session: string;
    rooms: string[];
  }>;
  validator_report?: any;
}

export interface BookingRecord {
  id: string;
  submitted_at: string;
  requester: string;
  role: 'admin' | 'department_coordinator' | 'faculty' | 'club';
  requested_category: string;
  effective_category: string;
  title: string;
  attendance: number;
  duration_periods: number;
  windows: Array<{ day: string; from_period: number; to_period: number }>;
  room_types: string[];
  needs: string[];
  requested_room?: string | null;
  mandatory_for_groups: string[];
  raw_text?: string;
  status: 'pending' | 'approved' | 'rejected' | 'alternative_offered';
  allocated_room?: string | null;
  allocated_day?: string | null;
  allocated_start_period?: number | null;
  allocated_end_period?: number | null;
  decision_reason?: string | null;
  created_by?: string;
  decided_by?: string;
  decided_at?: string;
}

export interface DisruptionRecord {
  id: string;
  title: string;
  description?: string;
  submitted_at: string;
  submitted_by: string;
  status: 'proposed' | 'approved' | 'rejected';
  changes: Array<{
    type: string;
    faculty_id?: string;
    room_id?: string;
    days?: string[];
    periods?: number[];
    reason?: string;
    session?: any;
    faculty?: any;
    session_id?: string;
  }>;
  proposed_schedule_version_id?: string;
  stability_metrics?: {
    sessions_moved: number;
    time_changed: number;
    room_only_changed: number;
    moved_ids: string[];
  };
  validator_report?: any;
  approved_by?: string;
  approved_at?: string;
}

export interface UserRecord {
  id: string; // e.g. "usr-admin", "usr-coord-cse", "usr-student-cse3"
  username: string;
  display_name: string;
  email: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'pending';
  department?: string;
  faculty_id?: string;
  student_group_id?: string;
  club_name?: string;
  auth_tokens: string[];
  password_hash?: string;
  created_at: string;
  updated_at: string;
  last_login_at?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  user_id: string;
  user_name: string;
  role: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  details?: any;
  status: 'success' | 'failure';
}

export interface IStorage {
  // Dataset
  getDataset(): Promise<any>;
  saveDataset(dataset: any): Promise<void>;

  // Schedules
  getAllSchedules(): Promise<Record<string, ScheduleVersion>>;
  getScheduleById(id: string): Promise<ScheduleVersion | null>;
  getApprovedSchedule(): Promise<ScheduleVersion | null>;
  saveSchedule(schedule: ScheduleVersion): Promise<void>;
  promoteSchedule(versionId: string, approvedBy: string): Promise<ScheduleVersion>;

  // Bookings
  getAllBookings(): Promise<Record<string, BookingRecord>>;
  getBookingById(id: string): Promise<BookingRecord | null>;
  saveBooking(booking: BookingRecord): Promise<void>;
  saveAllBookings(bookings: Record<string, BookingRecord>): Promise<void>;

  // Disruptions
  getAllDisruptions(): Promise<Record<string, DisruptionRecord>>;
  getDisruptionById(id: string): Promise<DisruptionRecord | null>;
  saveDisruption(disruption: DisruptionRecord): Promise<void>;

  // Audit
  logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void>;
  getAuditLogs(limit?: number): Promise<AuditLogEntry[]>;

  // Calendar Sync Metadata
  getCalendarSyncData(): Promise<any>;
  saveCalendarSyncData(data: any): Promise<void>;

  // Users & Auth
  getAllUsers(): Promise<Record<string, UserRecord>>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByUsername(username: string): Promise<UserRecord | null>;
  getUserByToken(token: string): Promise<UserRecord | null>;
  saveUser(user: UserRecord): Promise<void>;
  createUser(userData: Omit<UserRecord, 'created_at' | 'updated_at'>): Promise<UserRecord>;
  updateUser(id: string, updates: Partial<UserRecord>): Promise<UserRecord>;
  validateReferentialIntegrity(user: Partial<UserRecord>): Promise<void>;
}

