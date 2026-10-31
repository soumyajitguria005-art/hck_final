import fs from 'fs';
import path from 'path';
import { STORAGE_DIR, DATASET_PATH, EXPORTS_DIR } from './config.js';
import {
  IStorage,
  ScheduleVersion,
  BookingRecord,
  DisruptionRecord,
  UserRecord,
  AuditLogEntry,
} from './storageInterface.js';
import { PostgresStorage } from './postgresStorage.js';

export * from './storageInterface.js';

export class StorageManager implements IStorage {
  private baseDir: string;
  private datasetFile: string;
  private schedulesFile: string;
  private bookingsFile: string;
  private disruptionsFile: string;
  private auditFile: string;
  private calendarFile: string;
  private usersFile: string;

  constructor() {
    this.baseDir = STORAGE_DIR;
    this.datasetFile = path.join(this.baseDir, 'dataset.json');
    this.schedulesFile = path.join(this.baseDir, 'schedules.json');
    this.bookingsFile = path.join(this.baseDir, 'bookings.json');
    this.disruptionsFile = path.join(this.baseDir, 'disruptions.json');
    this.auditFile = path.join(this.baseDir, 'audit_log.json');
    this.calendarFile = path.join(this.baseDir, 'calendar_sync.json');
    this.usersFile = path.join(this.baseDir, 'users.json');

    this.ensureInitialized();
  }

  private writeJsonAtomic(filePath: string, data: any): void {
    const tmpFile = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, filePath);
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err) {
      console.error(`Error reading ${filePath}:`, err);
      return fallback;
    }
  }

  public ensureInitialized(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    // 1. Dataset
    if (!fs.existsSync(this.datasetFile)) {
      if (fs.existsSync(DATASET_PATH)) {
        const initialData = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
        this.writeJsonAtomic(this.datasetFile, initialData);
      }
    }

    // 2. Schedules
    if (!fs.existsSync(this.schedulesFile)) {
      const baselineExportPath = path.join(EXPORTS_DIR, 'schedule.json');
      const baselineReportPath = path.join(EXPORTS_DIR, 'report.json');
      const initialSchedules: Record<string, ScheduleVersion> = {};

      if (fs.existsSync(baselineExportPath)) {
        const baseExport = JSON.parse(fs.readFileSync(baselineExportPath, 'utf-8'));
        const baseReport = fs.existsSync(baselineReportPath)
          ? JSON.parse(fs.readFileSync(baselineReportPath, 'utf-8'))
          : null;

        initialSchedules['v1'] = {
          id: 'v1',
          name: 'Semester Baseline Master Timetable',
          status: 'approved',
          created_at: new Date().toISOString(),
          created_by: 'system',
          approved_at: new Date().toISOString(),
          approved_by: 'usr-admin',
          dataset_id: baseExport.dataset_id || 'cit-public-v1',
          team: baseExport.team || 'CIT Arch Team',
          sessions: baseExport.sessions || [],
          fest_week: baseExport.fest_week,
          exams: baseExport.exams,
          validator_report: baseReport,
        };
      }
      this.writeJsonAtomic(this.schedulesFile, initialSchedules);
    }

    // 3. Bookings
    if (!fs.existsSync(this.bookingsFile)) {
      const initialBookings: Record<string, BookingRecord> = {};
      const ds = this.readJson<any>(this.datasetFile, {});
      const allSchedules = this.readJson<Record<string, ScheduleVersion>>(this.schedulesFile, {});
      const sched = Object.values(allSchedules).find((s) => s.status === 'approved');
      const bookedDecisions = sched?.fest_week?.bookings || [];
      const decMap = new Map(bookedDecisions.map((d: any) => [d.request_id, d]));

      for (const req of (ds.booking_requests || []) as any[]) {
        const dec = decMap.get(req.id);
        initialBookings[req.id] = {
          ...req,
          effective_category: dec ? (req.role === 'club' ? 'club_event' : req.requested_category) : req.requested_category,
          status: dec ? dec.status : 'pending',
          allocated_room: dec?.room_id || null,
          allocated_day: dec?.day || null,
          allocated_start_period: dec?.start_period || null,
          allocated_end_period: dec?.end_period || null,
          decision_reason: dec?.reason || null,
          created_by: 'system',
          decided_by: dec ? 'system' : undefined,
          decided_at: dec ? new Date().toISOString() : undefined,
        };
      }
      this.writeJsonAtomic(this.bookingsFile, initialBookings);
    }

    // 4. Disruptions
    if (!fs.existsSync(this.disruptionsFile)) {
      this.writeJsonAtomic(this.disruptionsFile, {});
    }

    // 5. Audit Log
    if (!fs.existsSync(this.auditFile)) {
      this.writeJsonAtomic(this.auditFile, []);
    }

    // 6. Calendar Sync
    if (!fs.existsSync(this.calendarFile)) {
      this.writeJsonAtomic(this.calendarFile, {
        connections: {},
        event_mappings: {},
      });
    }

    // 7. Persistent User Accounts
    if (!fs.existsSync(this.usersFile)) {
      const now = new Date().toISOString();
      const initialUsers: Record<string, UserRecord> = {
        'usr-admin': {
          id: 'usr-admin',
          username: 'admin.nayak',
          display_name: 'Dr. S. K. Nayak (Dean Academics)',
          email: 'dean.academics@cit.ac.in',
          role: 'admin',
          status: 'active',
          department: 'Administration',
          auth_tokens: ['admin-token-secret-01', 'usr-admin', 'admin'],
          created_at: now,
          updated_at: now,
        },
        'usr-coord-cse': {
          id: 'usr-coord-cse',
          username: 'coord.cse',
          display_name: 'Prof. Ananya Sen (CSE Coordinator)',
          email: 'coord.cse@cit.ac.in',
          role: 'department_coordinator',
          status: 'active',
          department: 'CSE',
          auth_tokens: ['coord-cse-token-01', 'usr-coord-cse', 'department_coordinator'],
          created_at: now,
          updated_at: now,
        },
        'usr-coord-ece': {
          id: 'usr-coord-ece',
          username: 'coord.ece',
          display_name: 'Prof. Rajesh Sharma (ECE Coordinator)',
          email: 'coord.ece@cit.ac.in',
          role: 'department_coordinator',
          status: 'active',
          department: 'ECE',
          auth_tokens: ['coord-ece-token-01', 'usr-coord-ece'],
          created_at: now,
          updated_at: now,
        },
        'usr-faculty-f19': {
          id: 'usr-faculty-f19',
          username: 'faculty.f19',
          display_name: 'Prof. S. Ramanujan (Faculty)',
          email: 'ramanujan.math@cit.ac.in',
          role: 'faculty',
          status: 'active',
          department: 'Mathematics',
          faculty_id: 'F19',
          auth_tokens: ['faculty-f19-token-01', 'usr-faculty-f19', 'faculty'],
          created_at: now,
          updated_at: now,
        },
        'usr-faculty-f01': {
          id: 'usr-faculty-f01',
          username: 'faculty.f01',
          display_name: 'Prof. Alan Turing (CSE Faculty)',
          email: 'turing.cse@cit.ac.in',
          role: 'faculty',
          status: 'active',
          department: 'CSE',
          faculty_id: 'F01',
          auth_tokens: ['faculty-f01-token-01', 'usr-faculty-f01'],
          created_at: now,
          updated_at: now,
        },
        'usr-club-drama': {
          id: 'usr-club-drama',
          username: 'club.drama',
          display_name: 'Kabir Varma (Dramatics Society)',
          email: 'drama.club@cit.ac.in',
          role: 'club',
          status: 'active',
          club_name: 'Dramatics Society',
          auth_tokens: ['club-drama-token-01', 'usr-club-drama', 'club'],
          created_at: now,
          updated_at: now,
        },
        'usr-club-robotics': {
          id: 'usr-club-robotics',
          username: 'club.robotics',
          display_name: 'Aditi Roy (Robotics Club)',
          email: 'robotics.club@cit.ac.in',
          role: 'club',
          status: 'active',
          club_name: 'Robotics Club',
          auth_tokens: ['club-robotics-token-01', 'usr-club-robotics'],
          created_at: now,
          updated_at: now,
        },
        'usr-student-cse3': {
          id: 'usr-student-cse3',
          username: 'student.aarav',
          display_name: 'Aarav Patel (Student)',
          email: 'aarav.cse3@cit.ac.in',
          role: 'student',
          status: 'active',
          department: 'CSE',
          student_group_id: 'CSE-3',
          auth_tokens: ['student-cse3-token-01', 'usr-student-cse3', 'student'],
          created_at: now,
          updated_at: now,
        },
        'usr-student-y1a': {
          id: 'usr-student-y1a',
          username: 'student.priya',
          display_name: 'Priya Sharma (Year 1 Student)',
          email: 'priya.y1a@cit.ac.in',
          role: 'student',
          status: 'active',
          department: 'CSE',
          student_group_id: 'Y1-A',
          auth_tokens: ['student-y1a-token-01', 'usr-student-y1a'],
          created_at: now,
          updated_at: now,
        },
      };
      this.writeJsonAtomic(this.usersFile, initialUsers);
    }
  }

  // --- DATASET ---
  public async getDataset(): Promise<any> {
    return this.readJson(this.datasetFile, {});
  }

  public async saveDataset(dataset: any): Promise<void> {
    this.writeJsonAtomic(this.datasetFile, dataset);
  }

  // --- SCHEDULES ---
  public async getAllSchedules(): Promise<Record<string, ScheduleVersion>> {
    return this.readJson<Record<string, ScheduleVersion>>(this.schedulesFile, {});
  }

  public async getScheduleById(id: string): Promise<ScheduleVersion | null> {
    const all = await this.getAllSchedules();
    return all[id] || null;
  }

  public async getApprovedSchedule(): Promise<ScheduleVersion | null> {
    const all = await this.getAllSchedules();
    // Return latest approved schedule version
    const approved = Object.values(all)
      .filter((s) => s.status === 'approved')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return approved[0] || null;
  }

  public async saveSchedule(schedule: ScheduleVersion): Promise<void> {
    const all = await this.getAllSchedules();
    all[schedule.id] = schedule;
    this.writeJsonAtomic(this.schedulesFile, all);
  }

  public async promoteSchedule(versionId: string, approvedBy: string): Promise<ScheduleVersion> {
    const all = await this.getAllSchedules();
    const target = all[versionId];
    if (!target) {
      throw new Error(`Schedule version '${versionId}' not found.`);
    }
    for (const s of Object.values(all)) {
      if (s.status === 'approved' && s.id !== versionId) {
        s.status = 'archived';
      }
    }
    target.status = 'approved';
    target.approved_at = new Date().toISOString();
    target.approved_by = approvedBy;
    this.writeJsonAtomic(this.schedulesFile, all);
    return target;
  }

  // --- BOOKINGS ---
  public async getAllBookings(): Promise<Record<string, BookingRecord>> {
    return this.readJson<Record<string, BookingRecord>>(this.bookingsFile, {});
  }

  public async getBookingById(id: string): Promise<BookingRecord | null> {
    const all = await this.getAllBookings();
    return all[id] || null;
  }

  public async saveBooking(booking: BookingRecord): Promise<void> {
    const all = await this.getAllBookings();
    all[booking.id] = booking;
    this.writeJsonAtomic(this.bookingsFile, all);
  }

  public async saveAllBookings(bookings: Record<string, BookingRecord>): Promise<void> {
    this.writeJsonAtomic(this.bookingsFile, bookings);
  }

  // --- DISRUPTIONS ---
  public async getAllDisruptions(): Promise<Record<string, DisruptionRecord>> {
    return this.readJson<Record<string, DisruptionRecord>>(this.disruptionsFile, {});
  }

  public async getDisruptionById(id: string): Promise<DisruptionRecord | null> {
    const all = await this.getAllDisruptions();
    return all[id] || null;
  }

  public async saveDisruption(disruption: DisruptionRecord): Promise<void> {
    const all = await this.getAllDisruptions();
    all[disruption.id] = disruption;
    this.writeJsonAtomic(this.disruptionsFile, all);
  }

  // --- AUDIT LOGS ---
  public async logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const logs = this.readJson<AuditLogEntry[]>(this.auditFile, []);
    const newEntry: AuditLogEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    logs.push(newEntry);
    this.writeJsonAtomic(this.auditFile, logs);
  }

  public async getAuditLogs(limit: number = 100): Promise<AuditLogEntry[]> {
    const logs = this.readJson<AuditLogEntry[]>(this.auditFile, []);
    return logs.slice(-limit).reverse();
  }

  // --- CALENDAR SYNC METADATA ---
  public async getCalendarSyncData(): Promise<any> {
    return this.readJson(this.calendarFile, { connections: {}, event_mappings: {} });
  }

  public async saveCalendarSyncData(data: any): Promise<void> {
    this.writeJsonAtomic(this.calendarFile, data);
  }

  // --- PERSISTENT USERS & AUTHENTICATION ---
  public async getAllUsers(): Promise<Record<string, UserRecord>> {
    return this.readJson<Record<string, UserRecord>>(this.usersFile, {});
  }

  public async getUserById(id: string): Promise<UserRecord | null> {
    const all = await this.getAllUsers();
    return all[id] || null;
  }

  public async getUserByUsername(username: string): Promise<UserRecord | null> {
    const all = await this.getAllUsers();
    return Object.values(all).find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
  }

  public async getUserByToken(token: string): Promise<UserRecord | null> {
    const all = await this.getAllUsers();
    return (
      Object.values(all).find((u) => u.auth_tokens.includes(token) || u.id === token) || null
    );
  }

  public async saveUser(user: UserRecord): Promise<void> {
    const all = await this.getAllUsers();
    all[user.id] = user;
    this.writeJsonAtomic(this.usersFile, all);
  }

  public async validateReferentialIntegrity(user: Partial<UserRecord>): Promise<void> {
    const dataset = await this.getDataset();
    const validDepartments = ['CSE', 'ECE', 'EE', 'ME', 'CE', 'Mathematics', 'Physics', 'Humanities', 'Administration'];

    if (user.department && !validDepartments.includes(user.department)) {
      throw new Error(`Referential integrity error: Department '${user.department}' is not recognized in the CIT institution.`);
    }

    if (user.student_group_id) {
      const validGroup = (dataset.student_groups || []).some((g: any) => g.id === user.student_group_id);
      if (!validGroup) {
        throw new Error(`Referential integrity error: Student group '${user.student_group_id}' does not exist in authoritative student_groups.`);
      }
    }

    if (user.faculty_id) {
      const validFaculty = (dataset.faculty || []).some((f: any) => f.id === user.faculty_id);
      if (!validFaculty) {
        throw new Error(`Referential integrity error: Faculty ID '${user.faculty_id}' does not exist in authoritative faculty records.`);
      }
    }
  }

  public async createUser(userData: Omit<UserRecord, 'created_at' | 'updated_at'>): Promise<UserRecord> {
    await this.validateReferentialIntegrity(userData);
    const all = await this.getAllUsers();

    if (all[userData.id]) {
      throw new Error(`User with ID '${userData.id}' already exists.`);
    }
    if (Object.values(all).some((u) => u.username.toLowerCase() === userData.username.toLowerCase())) {
      throw new Error(`Username '${userData.username}' is already taken.`);
    }

    const now = new Date().toISOString();
    const newUser: UserRecord = {
      ...userData,
      created_at: now,
      updated_at: now,
    };

    all[newUser.id] = newUser;
    this.writeJsonAtomic(this.usersFile, all);
    return newUser;
  }

  public async updateUser(id: string, updates: Partial<UserRecord>): Promise<UserRecord> {
    const all = await this.getAllUsers();
    const existing = all[id];
    if (!existing) {
      throw new Error(`User with ID '${id}' not found.`);
    }

    await this.validateReferentialIntegrity(updates);

    if (updates.username && updates.username.toLowerCase() !== existing.username.toLowerCase()) {
      if (Object.values(all).some((u) => u.id !== id && u.username.toLowerCase() === updates.username!.toLowerCase())) {
        throw new Error(`Username '${updates.username}' is already taken.`);
      }
    }

    const updatedUser: UserRecord = {
      ...existing,
      ...updates,
      id: existing.id, // Immutable ID
      updated_at: new Date().toISOString(),
    };

    all[id] = updatedUser;
    this.writeJsonAtomic(this.usersFile, all);
    return updatedUser;
  }
}

export const jsonStorage = new StorageManager();

export function createStorage(): IStorage {
  const driver = (process.env.STORAGE_DRIVER || 'json').toLowerCase();

  if (driver !== 'json' && driver !== 'postgres') {
    throw new Error(
      `[Storage Safety] Unrecognized or unsupported STORAGE_DRIVER='${driver}'. Allowed drivers are 'json' or 'postgres'.`
    );
  }

  if (driver === 'postgres') {
    if (!process.env.DATABASE_URL) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          '[Storage Safety] Production error: STORAGE_DRIVER=postgres requires DATABASE_URL to be defined. Refusing silent fallback to ephemeral storage.'
        );
      }
      console.warn('[Storage] STORAGE_DRIVER=postgres requested but DATABASE_URL is not provided. Falling back safely to JSON storage.');
      return jsonStorage;
    }
    console.log('[Storage] Initializing PostgreSQL storage adapter (STORAGE_DRIVER=postgres)...');
    return new PostgresStorage();
  }

  // Default active driver: JSON
  console.log(`[Storage] Active driver: json (storage_dir=${STORAGE_DIR})`);
  return jsonStorage;
}

export const storage: IStorage = createStorage();

