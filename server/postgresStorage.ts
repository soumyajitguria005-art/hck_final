import { Pool, PoolClient } from 'pg';
import {
  IStorage,
  ScheduleVersion,
  BookingRecord,
  DisruptionRecord,
  UserRecord,
  AuditLogEntry,
} from './storageInterface.js';

export class PostgresStorage implements IStorage {
  private pool: Pool;
  private isConnected: boolean = false;

  constructor(connectionString?: string, customPool?: Pool) {
    if (customPool) {
      this.pool = customPool;
      return;
    }
    const url = connectionString || process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'PostgresStorage initialization failed: DATABASE_URL environment variable is required when STORAGE_DRIVER=postgres'
      );
    }
    this.pool = new Pool({
      connectionString: url,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    });
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async initPool(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
      this.isConnected = true;
      console.log('[PostgresStorage] Connected successfully to PostgreSQL.');
    } catch (err) {
      console.error('[PostgresStorage] Connection error:', err);
      throw err;
    }
  }

  // --- DATASET RECONSTRUCTION ---
  public async getDataset(): Promise<any> {
    const client = await this.pool.connect();
    try {
      const roomsRes = await client.query('SELECT * FROM rooms ORDER BY id');
      const facultyRes = await client.query('SELECT * FROM faculty ORDER BY id');
      const groupsRes = await client.query('SELECT * FROM student_groups ORDER BY id');
      const coursesRes = await client.query('SELECT * FROM courses ORDER BY id');

      const sessionsRes = await client.query(`
        SELECT s.*, 
          COALESCE(ARRAY_AGG(DISTINCT sg.group_id) FILTER (WHERE sg.group_id IS NOT NULL), '{}') as groups,
          COALESCE(ARRAY_AGG(DISTINCT srt.room_type) FILTER (WHERE srt.room_type IS NOT NULL), '{}') as room_types
        FROM sessions s
        LEFT JOIN session_groups sg ON s.id = sg.session_id
        LEFT JOIN session_room_types srt ON s.id = srt.session_id
        GROUP BY s.id
        ORDER BY s.id
      `);

      const examsRes = await client.query(`
        SELECT e.*,
          COALESCE(ARRAY_AGG(DISTINCT ec.course_id) FILTER (WHERE ec.course_id IS NOT NULL), '{}') as course_ids,
          COALESCE(ARRAY_AGG(DISTINCT eg.group_id) FILTER (WHERE eg.group_id IS NOT NULL), '{}') as groups
        FROM exams e
        LEFT JOIN exam_courses ec ON e.id = ec.exam_id
        LEFT JOIN exam_groups eg ON e.id = eg.exam_id
        GROUP BY e.id
        ORDER BY e.id
      `);

      const bookingsRes = await this.getAllBookings();

      return {
        dataset_id: 'cit-public-v1',
        institute: 'Chilika Institute of Technology',
        rooms: roomsRes.rows.map((r) => ({
          id: r.id,
          name: r.name,
          building: r.building,
          type: r.type,
          capacity: r.capacity,
          accessible: r.accessible,
          features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features || [],
          allowed_uses: typeof r.allowed_uses === 'string' ? JSON.parse(r.allowed_uses) : r.allowed_uses || [],
        })),
        faculty: facultyRes.rows.map((f) => ({
          id: f.id,
          name: f.name,
          department: f.department_code,
          max_hours_per_day: f.max_hours_per_day,
          needs_accessible: f.needs_accessible,
          preferences: typeof f.preferences === 'string' ? JSON.parse(f.preferences) : f.preferences || [],
        })),
        student_groups: groupsRes.rows.map((g) => ({
          id: g.id,
          name: g.name,
          year: g.year,
          department: g.department_code,
          size: g.size,
          needs_accessible: g.needs_accessible,
        })),
        courses: coursesRes.rows.map((c) => ({
          id: c.id,
          title: c.title,
          department: c.department_code,
          year: c.year,
          lecture_hours: c.lecture_hours,
          tutorial_hours: c.tutorial_hours,
          lab_blocks: c.lab_blocks,
        })),
        sessions: sessionsRes.rows.map((s) => ({
          id: s.id,
          course_id: s.course_id,
          kind: s.kind,
          faculty_id: s.faculty_id,
          groups: s.groups || [],
          size: s.size,
          duration: s.duration,
          room_types: s.room_types || [],
          needs_accessible: s.needs_accessible,
          basket_slot: s.basket_slot || null,
          fixed_slot: s.fixed_slot || null,
        })),
        exams: examsRes.rows.map((e) => ({
          id: e.id,
          course_ids: e.course_ids || [],
          groups: e.groups || [],
          size: e.size,
          duration_hours: e.duration_hours,
        })),
        booking_requests: Object.values(bookingsRes),
      };
    } finally {
      client.release();
    }
  }

  public async saveDataset(dataset: any): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of dataset.rooms || []) {
        await client.query(
          `INSERT INTO rooms (id, name, building, type, capacity, accessible, features, allowed_uses)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             capacity = EXCLUDED.capacity,
             accessible = EXCLUDED.accessible,
             features = EXCLUDED.features,
             allowed_uses = EXCLUDED.allowed_uses`,
          [r.id, r.name, r.building, r.type, r.capacity, r.accessible, JSON.stringify(r.features || []), JSON.stringify(r.allowed_uses || [])]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // --- SCHEDULES & RECONSTRUCTION ---
  private async reconstructSchedule(row: any, client: PoolClient): Promise<ScheduleVersion> {
    const sessionsRes = await client.query(
      `SELECT session_id, day, start_period, room_id
       FROM scheduled_sessions
       WHERE schedule_version_id = $1
       ORDER BY day, start_period, session_id`,
      [row.id]
    );

    const examsRes = await client.query(
      `SELECT es.exam_id, es.day, es.session_slot as session,
              COALESCE(ARRAY_AGG(esr.room_id) FILTER (WHERE esr.room_id IS NOT NULL), '{}') as rooms
       FROM exam_schedules es
       LEFT JOIN exam_schedule_rooms esr ON es.id = esr.exam_schedule_id
       WHERE es.schedule_version_id = $1
       GROUP BY es.id, es.exam_id, es.day, es.session_slot
       ORDER BY es.day, es.session_slot, es.exam_id`,
      [row.id]
    );

    let validatorReport = row.validator_report;
    if (typeof validatorReport === 'string') {
      try {
        validatorReport = JSON.parse(validatorReport);
      } catch (_) {}
    }

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      created_by: row.created_by,
      approved_at: row.approved_at ? (row.approved_at instanceof Date ? row.approved_at.toISOString() : String(row.approved_at)) : undefined,
      approved_by: row.approved_by || undefined,
      dataset_id: row.dataset_id,
      team: row.team,
      disruption_id: row.disruption_id || undefined,
      sessions: sessionsRes.rows.map((s) => ({
        session_id: s.session_id,
        day: s.day,
        start_period: s.start_period,
        room_id: s.room_id,
      })),
      fest_week: row.fest_week ? (typeof row.fest_week === 'string' ? JSON.parse(row.fest_week) : row.fest_week) : undefined,
      exams: examsRes.rows.length > 0 ? examsRes.rows.map((e) => ({
        exam_id: e.exam_id,
        day: e.day,
        session: e.session,
        rooms: e.rooms || [],
      })) : undefined,
      validator_report: validatorReport,
    };
  }

  public async getAllSchedules(): Promise<Record<string, ScheduleVersion>> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM schedule_versions ORDER BY created_at DESC');
      const result: Record<string, ScheduleVersion> = {};
      for (const row of res.rows) {
        result[row.id] = await this.reconstructSchedule(row, client);
      }
      return result;
    } finally {
      client.release();
    }
  }

  public async getScheduleById(id: string): Promise<ScheduleVersion | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM schedule_versions WHERE id = $1', [id]);
      if (res.rows.length === 0) return null;
      return await this.reconstructSchedule(res.rows[0], client);
    } finally {
      client.release();
    }
  }

  public async getApprovedSchedule(): Promise<ScheduleVersion | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        "SELECT * FROM schedule_versions WHERE status = 'approved' ORDER BY approved_at DESC, created_at DESC LIMIT 1"
      );
      if (res.rows.length === 0) return null;
      return await this.reconstructSchedule(res.rows[0], client);
    } finally {
      client.release();
    }
  }

  public async saveSchedule(schedule: ScheduleVersion): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO schedule_versions (id, name, status, created_at, created_by, approved_at, approved_by, dataset_id, team, disruption_id, validator_report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            approved_at = EXCLUDED.approved_at,
            approved_by = EXCLUDED.approved_by,
            validator_report = EXCLUDED.validator_report`,
        [
          schedule.id,
          schedule.name,
          schedule.status,
          schedule.created_at,
          schedule.created_by,
          schedule.approved_at || null,
          schedule.approved_by || null,
          schedule.dataset_id,
          schedule.team,
          schedule.disruption_id || null,
          JSON.stringify(schedule.validator_report || null),
        ]
      );

      // Insert scheduled sessions
      if (schedule.sessions && schedule.sessions.length > 0) {
        await client.query('DELETE FROM scheduled_sessions WHERE schedule_version_id = $1', [schedule.id]);
        for (const s of schedule.sessions) {
          await client.query(
            `INSERT INTO scheduled_sessions (schedule_version_id, session_id, day, start_period, room_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (schedule_version_id, session_id) DO UPDATE SET
               day = EXCLUDED.day,
               start_period = EXCLUDED.start_period,
               room_id = EXCLUDED.room_id`,
            [schedule.id, s.session_id, s.day, s.start_period, s.room_id]
          );
        }
      }

      // Insert exams if provided
      if (schedule.exams && schedule.exams.length > 0) {
        await client.query('DELETE FROM exam_schedules WHERE schedule_version_id = $1', [schedule.id]);
        for (const ex of schedule.exams) {
          const exRes = await client.query(
            `INSERT INTO exam_schedules (schedule_version_id, exam_id, day, session_slot)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [schedule.id, ex.exam_id, ex.day, ex.session]
          );
          const schedId = exRes.rows[0]?.id;
          if (schedId && ex.rooms) {
            for (const rm of ex.rooms) {
              await client.query(
                `INSERT INTO exam_schedule_rooms (exam_schedule_id, room_id)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [schedId, rm]
              );
            }
          }
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public async promoteSchedule(versionId: string, approvedBy: string): Promise<ScheduleVersion> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Archive any currently active approved schedule version
      await client.query(
        "UPDATE schedule_versions SET status = 'archived' WHERE status = 'approved' AND id <> $1",
        [versionId]
      );

      // 2. Promote target schedule to approved
      const res = await client.query(
        `UPDATE schedule_versions
         SET status = 'approved', approved_at = NOW(), approved_by = $1
         WHERE id = $2
         RETURNING *`,
        [approvedBy, versionId]
      );

      if (res.rows.length === 0) {
        throw new Error(`Schedule version '${versionId}' not found for promotion.`);
      }

      const promoted = await this.reconstructSchedule(res.rows[0], client);
      await client.query('COMMIT');
      return promoted;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // --- BOOKINGS ---
  private async reconstructBooking(row: any, client: PoolClient): Promise<BookingRecord> {
    const windowsRes = await client.query(
      'SELECT day, from_period, to_period FROM booking_windows WHERE booking_id = $1 ORDER BY day, from_period',
      [row.id]
    );
    const roomTypesRes = await client.query(
      'SELECT room_type FROM booking_room_types WHERE booking_id = $1',
      [row.id]
    );
    const needsRes = await client.query(
      'SELECT need_tag FROM booking_needs WHERE booking_id = $1',
      [row.id]
    );
    const groupsRes = await client.query(
      'SELECT group_id FROM booking_mandatory_groups WHERE booking_id = $1',
      [row.id]
    );

    return {
      id: row.id,
      submitted_at: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
      requester: row.requester,
      role: row.role,
      requested_category: row.requested_category,
      effective_category: row.effective_category,
      title: row.title,
      attendance: row.attendance,
      duration_periods: row.duration_periods,
      windows: windowsRes.rows.map((w) => ({
        day: w.day,
        from_period: w.from_period,
        to_period: w.to_period,
      })),
      room_types: roomTypesRes.rows.map((rt) => rt.room_type),
      needs: needsRes.rows.map((n) => n.need_tag),
      requested_room: row.requested_room || null,
      mandatory_for_groups: groupsRes.rows.map((g) => g.group_id),
      raw_text: row.raw_text || undefined,
      status: row.status,
      allocated_room: row.allocated_room || null,
      allocated_day: row.allocated_day || null,
      allocated_start_period: row.allocated_start_period || null,
      allocated_end_period: row.allocated_end_period || null,
      decision_reason: row.decision_reason || null,
      created_by: row.created_by,
      decided_by: row.decided_by || null,
      decided_at: row.decided_at ? (row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at)) : null,
    };
  }

  public async getAllBookings(): Promise<Record<string, BookingRecord>> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM venue_bookings ORDER BY submitted_at ASC');
      const result: Record<string, BookingRecord> = {};
      for (const row of res.rows) {
        result[row.id] = await this.reconstructBooking(row, client);
      }
      return result;
    } finally {
      client.release();
    }
  }

  public async getBookingById(id: string): Promise<BookingRecord | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM venue_bookings WHERE id = $1', [id]);
      if (res.rows.length === 0) return null;
      return await this.reconstructBooking(res.rows[0], client);
    } finally {
      client.release();
    }
  }

  public async saveBooking(booking: BookingRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO venue_bookings (
           id, submitted_at, requester, role, requested_category, effective_category,
           title, attendance, duration_periods, requested_room, raw_text, status,
           allocated_room, allocated_day, allocated_start_period, allocated_end_period,
           decision_reason, created_by, decided_by, decided_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           allocated_room = EXCLUDED.allocated_room,
           allocated_day = EXCLUDED.allocated_day,
           allocated_start_period = EXCLUDED.allocated_start_period,
           allocated_end_period = EXCLUDED.allocated_end_period,
           decision_reason = EXCLUDED.decision_reason,
           decided_by = EXCLUDED.decided_by,
           decided_at = EXCLUDED.decided_at`,
        [
          booking.id,
          booking.submitted_at,
          booking.requester,
          booking.role,
          booking.requested_category,
          booking.effective_category,
          booking.title,
          booking.attendance,
          booking.duration_periods,
          booking.requested_room || null,
          booking.raw_text || null,
          booking.status,
          booking.allocated_room || null,
          booking.allocated_day || null,
          booking.allocated_start_period || null,
          booking.allocated_end_period || null,
          booking.decision_reason || null,
          booking.created_by || 'usr-admin',
          booking.decided_by || null,
          booking.decided_at || null,
        ]
      );

      // Windows
      await client.query('DELETE FROM booking_windows WHERE booking_id = $1', [booking.id]);
      for (const w of booking.windows || []) {
        await client.query(
          `INSERT INTO booking_windows (booking_id, day, from_period, to_period)
           VALUES ($1, $2, $3, $4)`,
          [booking.id, w.day, w.from_period, w.to_period]
        );
      }

      // Room types
      await client.query('DELETE FROM booking_room_types WHERE booking_id = $1', [booking.id]);
      for (const rt of booking.room_types || []) {
        await client.query(
          `INSERT INTO booking_room_types (booking_id, room_type)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [booking.id, rt]
        );
      }

      // Needs
      await client.query('DELETE FROM booking_needs WHERE booking_id = $1', [booking.id]);
      for (const n of booking.needs || []) {
        await client.query(
          `INSERT INTO booking_needs (booking_id, need_tag)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [booking.id, n]
        );
      }

      // Mandatory groups
      await client.query('DELETE FROM booking_mandatory_groups WHERE booking_id = $1', [booking.id]);
      for (const grp of booking.mandatory_for_groups || []) {
        await client.query(
          `INSERT INTO booking_mandatory_groups (booking_id, group_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [booking.id, grp]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public async saveAllBookings(bookings: Record<string, BookingRecord>): Promise<void> {
    for (const b of Object.values(bookings)) {
      await this.saveBooking(b);
    }
  }

  // --- DISRUPTIONS ---
  public async getAllDisruptions(): Promise<Record<string, DisruptionRecord>> {
    const res = await this.pool.query('SELECT * FROM disruptions ORDER BY submitted_at DESC');
    const result: Record<string, DisruptionRecord> = {};
    for (const row of res.rows) {
      result[row.id] = {
        id: row.id,
        title: row.title,
        description: row.description || undefined,
        submitted_at: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
        submitted_by: row.submitted_by,
        status: row.status,
        changes: typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes || [],
        proposed_schedule_version_id: row.proposed_schedule_version_id || undefined,
        stability_metrics: typeof row.stability_metrics === 'string' ? JSON.parse(row.stability_metrics) : row.stability_metrics || undefined,
        validator_report: typeof row.validator_report === 'string' ? JSON.parse(row.validator_report) : row.validator_report || undefined,
        approved_by: row.approved_by || undefined,
        approved_at: row.approved_at ? (row.approved_at instanceof Date ? row.approved_at.toISOString() : String(row.approved_at)) : undefined,
      };
    }
    return result;
  }

  public async getDisruptionById(id: string): Promise<DisruptionRecord | null> {
    const res = await this.pool.query('SELECT * FROM disruptions WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      submitted_at: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
      submitted_by: row.submitted_by,
      status: row.status,
      changes: typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes || [],
      proposed_schedule_version_id: row.proposed_schedule_version_id || undefined,
      stability_metrics: typeof row.stability_metrics === 'string' ? JSON.parse(row.stability_metrics) : row.stability_metrics || undefined,
      validator_report: typeof row.validator_report === 'string' ? JSON.parse(row.validator_report) : row.validator_report || undefined,
      approved_by: row.approved_by || undefined,
      approved_at: row.approved_at ? (row.approved_at instanceof Date ? row.approved_at.toISOString() : String(row.approved_at)) : undefined,
    };
  }

  public async saveDisruption(disruption: DisruptionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO disruptions (
         id, title, description, submitted_at, submitted_by, status,
         changes, proposed_schedule_version_id, stability_metrics, validator_report,
         approved_by, approved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         approved_by = EXCLUDED.approved_by,
         approved_at = EXCLUDED.approved_at`,
      [
        disruption.id,
        disruption.title,
        disruption.description || null,
        disruption.submitted_at,
        disruption.submitted_by,
        disruption.status,
        JSON.stringify(disruption.changes || []),
        disruption.proposed_schedule_version_id || null,
        JSON.stringify(disruption.stability_metrics || null),
        JSON.stringify(disruption.validator_report || null),
        disruption.approved_by || null,
        disruption.approved_at || null,
      ]
    );
  }

  // --- AUDIT LOGS ---
  public async logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const id = `audit-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const timestamp = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO audit_logs (id, timestamp, user_id, user_name, role, action, resource_type, resource_id, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        timestamp,
        entry.user_id,
        entry.user_name,
        entry.role,
        entry.action,
        entry.resource_type,
        entry.resource_id || null,
        JSON.stringify(entry.details || null),
        entry.status,
      ]
    );
  }

  public async getAuditLogs(limit: number = 100): Promise<AuditLogEntry[]> {
    const res = await this.pool.query(
      'SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );
    return res.rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
      user_id: r.user_id,
      user_name: r.user_name,
      role: r.role,
      action: r.action,
      resource_type: r.resource_type,
      resource_id: r.resource_id || undefined,
      details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details || undefined,
      status: r.status,
    }));
  }

  // --- CALENDAR SYNC METADATA ---
  public async getCalendarSyncData(): Promise<any> {
    const connRes = await this.pool.query('SELECT * FROM calendar_connections');
    const mapRes = await this.pool.query('SELECT * FROM calendar_event_mappings');
    const connections: Record<string, any> = {};
    for (const c of connRes.rows) {
      connections[c.user_id] = {
        connected: c.sync_enabled,
        calendar_id: c.calendar_id,
        sync_status: 'idle',
        connected_at: c.connected_at instanceof Date ? c.connected_at.toISOString() : String(c.connected_at),
      };
    }
    const mappings: Record<string, string> = {};
    for (const m of mapRes.rows) {
      mappings[`${m.schedule_version_id}_${m.event_type}_${m.local_id}`] = m.google_event_id;
    }
    return { connections, event_mappings: mappings };
  }

  public async saveCalendarSyncData(data: any): Promise<void> {
    if (data.connections) {
      for (const [userId, conn] of Object.entries<any>(data.connections)) {
        await this.pool.query(
          `INSERT INTO calendar_connections (user_id, calendar_id, sync_enabled, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             calendar_id = EXCLUDED.calendar_id,
             sync_enabled = EXCLUDED.sync_enabled,
             updated_at = NOW()`,
          [userId, conn.calendar_id || 'primary', conn.connected !== false]
        );
      }
    }
  }

  // --- USERS & AUTH ---
  private rowToUser(row: any, tokens: string[]): UserRecord {
    return {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      email: row.email,
      role: row.role,
      status: row.status,
      department: row.department_code || undefined,
      faculty_id: row.faculty_id || undefined,
      student_group_id: row.student_group_id || undefined,
      club_name: row.club_name || undefined,
      auth_tokens: tokens,
      password_hash: row.password_hash || undefined,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      last_login_at: row.last_login_at ? (row.last_login_at instanceof Date ? row.last_login_at.toISOString() : String(row.last_login_at)) : undefined,
    };
  }

  public async getAllUsers(): Promise<Record<string, UserRecord>> {
    const client = await this.pool.connect();
    try {
      const usersRes = await client.query('SELECT * FROM users ORDER BY username ASC');
      const tokensRes = await client.query('SELECT token, user_id FROM user_auth_tokens');
      const tokenMap = new Map<string, string[]>();
      for (const t of tokensRes.rows) {
        const arr = tokenMap.get(t.user_id) || [];
        arr.push(t.token);
        tokenMap.set(t.user_id, arr);
      }

      const result: Record<string, UserRecord> = {};
      for (const row of usersRes.rows) {
        result[row.id] = this.rowToUser(row, tokenMap.get(row.id) || [row.id]);
      }
      return result;
    } finally {
      client.release();
    }
  }

  public async getUserById(id: string): Promise<UserRecord | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM users WHERE id = $1', [id]);
      if (res.rows.length === 0) return null;
      const tokensRes = await client.query('SELECT token FROM user_auth_tokens WHERE user_id = $1', [id]);
      const tokens = tokensRes.rows.map((t) => t.token);
      if (!tokens.includes(id)) tokens.push(id);
      return this.rowToUser(res.rows[0], tokens);
    } finally {
      client.release();
    }
  }

  public async getUserByUsername(username: string): Promise<UserRecord | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      if (res.rows.length === 0) return null;
      const id = res.rows[0].id;
      const tokensRes = await client.query('SELECT token FROM user_auth_tokens WHERE user_id = $1', [id]);
      const tokens = tokensRes.rows.map((t) => t.token);
      if (!tokens.includes(id)) tokens.push(id);
      return this.rowToUser(res.rows[0], tokens);
    } finally {
      client.release();
    }
  }

  public async getUserByToken(token: string): Promise<UserRecord | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT u.* FROM users u
         LEFT JOIN user_auth_tokens t ON u.id = t.user_id
         WHERE t.token = $1 OR u.id = $1
         LIMIT 1`,
        [token]
      );
      if (res.rows.length === 0) return null;
      const id = res.rows[0].id;
      const tokensRes = await client.query('SELECT token FROM user_auth_tokens WHERE user_id = $1', [id]);
      const tokens = tokensRes.rows.map((t) => t.token);
      if (!tokens.includes(id)) tokens.push(id);
      return this.rowToUser(res.rows[0], tokens);
    } finally {
      client.release();
    }
  }

  public async saveUser(user: UserRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, username, display_name, email, role, status, department_code, faculty_id, student_group_id, club_name, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           role = EXCLUDED.role,
           status = EXCLUDED.status,
           department_code = EXCLUDED.department_code,
           faculty_id = EXCLUDED.faculty_id,
           student_group_id = EXCLUDED.student_group_id,
           club_name = EXCLUDED.club_name,
           updated_at = EXCLUDED.updated_at`,
        [
          user.id,
          user.username,
          user.display_name,
          user.email,
          user.role,
          user.status,
          user.department || null,
          user.faculty_id || null,
          user.student_group_id || null,
          user.club_name || null,
          user.password_hash || null,
          user.created_at,
          user.updated_at,
        ]
      );

      if (user.auth_tokens && user.auth_tokens.length > 0) {
        for (const tok of user.auth_tokens) {
          await client.query(
            `INSERT INTO user_auth_tokens (token, user_id, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (token) DO NOTHING`,
            [tok, user.id]
          );
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public async validateReferentialIntegrity(user: Partial<UserRecord>): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (user.department) {
        const deptRes = await client.query('SELECT code FROM departments WHERE code = $1', [user.department]);
        if (deptRes.rows.length === 0) {
          throw new Error(`Referential integrity error: Department '${user.department}' is not recognized in the CIT institution.`);
        }
      }
      if (user.student_group_id) {
        const grpRes = await client.query('SELECT id FROM student_groups WHERE id = $1', [user.student_group_id]);
        if (grpRes.rows.length === 0) {
          throw new Error(`Referential integrity error: Student group '${user.student_group_id}' does not exist in authoritative student_groups.`);
        }
      }
      if (user.faculty_id) {
        const facRes = await client.query('SELECT id FROM faculty WHERE id = $1', [user.faculty_id]);
        if (facRes.rows.length === 0) {
          throw new Error(`Referential integrity error: Faculty ID '${user.faculty_id}' does not exist in authoritative faculty records.`);
        }
      }
    } finally {
      client.release();
    }
  }

  public async createUser(userData: Omit<UserRecord, 'created_at' | 'updated_at'>): Promise<UserRecord> {
    await this.validateReferentialIntegrity(userData);
    const existingId = await this.getUserById(userData.id);
    if (existingId) {
      throw new Error(`User with ID '${userData.id}' already exists.`);
    }
    const existingName = await this.getUserByUsername(userData.username);
    if (existingName) {
      throw new Error(`Username '${userData.username}' is already taken.`);
    }

    const now = new Date().toISOString();
    const newUser: UserRecord = {
      ...userData,
      created_at: now,
      updated_at: now,
    };
    await this.saveUser(newUser);
    return newUser;
  }

  public async updateUser(id: string, updates: Partial<UserRecord>): Promise<UserRecord> {
    const existing = await this.getUserById(id);
    if (!existing) {
      throw new Error(`User with ID '${id}' not found.`);
    }

    await this.validateReferentialIntegrity(updates);

    if (updates.username && updates.username.toLowerCase() !== existing.username.toLowerCase()) {
      const conflict = await this.getUserByUsername(updates.username);
      if (conflict && conflict.id !== id) {
        throw new Error(`Username '${updates.username}' is already taken.`);
      }
    }

    const updatedUser: UserRecord = {
      ...existing,
      ...updates,
      id: existing.id,
      updated_at: new Date().toISOString(),
    };

    await this.saveUser(updatedUser);
    return updatedUser;
  }
}
