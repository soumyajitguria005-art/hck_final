import { ScheduleVersion, storage } from './storage.js';

export interface CalendarChangeReport {
  baselineVersionId: string;
  targetVersionId: string;
  generatedAt: string;
  addedSessions: Array<{
    sessionId: string;
    day: string;
    startPeriod: number;
    roomId: string;
  }>;
  removedSessions: Array<{
    sessionId: string;
    day: string;
    startPeriod: number;
    roomId: string;
  }>;
  updatedTimeSessions: Array<{
    sessionId: string;
    from: { day: string; startPeriod: number; roomId: string };
    to: { day: string; startPeriod: number; roomId: string };
  }>;
  updatedRoomSessions: Array<{
    sessionId: string;
    day: string;
    startPeriod: number;
    fromRoom: string;
    toRoom: string;
  }>;
  unchangedSessions: Array<{
    sessionId: string;
    day: string;
    startPeriod: number;
    roomId: string;
  }>;
  summary: {
    totalBaseline: number;
    totalTarget: number;
    addedCount: number;
    removedCount: number;
    timeChangedCount: number;
    roomOnlyChangedCount: number;
    unchangedCount: number;
  };
}

export interface GoogleCalendarEventModel {
  id: string; // Stable RFC-safe ID
  iCalUID: string;
  summary: string;
  description: string;
  location: string;
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  status: 'confirmed' | 'cancelled';
  extendedProperties?: {
    private: {
      citSessionId: string;
      citCourseId: string;
      citScheduleVersion: string;
      citDay: string;
      citStartPeriod: number;
      citRoomId: string;
    };
  };
}

// Period timing lookup for Monday of semester start (e.g., Feb 1, 2027)
const PERIOD_TIMES: Record<number, { start: string; end: string }> = {
  1: { start: '08:00:00', end: '09:00:00' },
  2: { start: '09:00:00', end: '10:00:00' },
  3: { start: '10:00:00', end: '11:00:00' },
  4: { start: '11:00:00', end: '12:00:00' },
  5: { start: '12:00:00', end: '13:00:00' },
  6: { start: '14:00:00', end: '15:00:00' },
  7: { start: '15:00:00', end: '16:00:00' },
  8: { start: '16:00:00', end: '17:00:00' },
  9: { start: '17:00:00', end: '18:00:00' },
  10: { start: '18:00:00', end: '19:00:00' },
  11: { start: '19:00:00', end: '20:00:00' },
  12: { start: '20:00:00', end: '21:00:00' },
  13: { start: '21:00:00', end: '22:00:00' },
};

const DAY_OFFSETS: Record<string, string> = {
  MON: '2027-02-01',
  TUE: '2027-02-02',
  WED: '2027-02-03',
  THU: '2027-02-04',
  FRI: '2027-02-05',
  SAT: '2027-02-06',
};

export class CalendarService {
  /**
   * Compares two schedule versions by stable session ID.
   * Produces detailed change report for downstream calendar sync.
   */
  public static compareSchedules(
    baseline: ScheduleVersion,
    target: ScheduleVersion
  ): CalendarChangeReport {
    const baseMap = new Map(baseline.sessions.map((s) => [s.session_id, s]));
    const targetMap = new Map(target.sessions.map((s) => [s.session_id, s]));

    const added: any[] = [];
    const removed: any[] = [];
    const updatedTime: any[] = [];
    const updatedRoom: any[] = [];
    const unchanged: any[] = [];

    // Analyze target sessions against baseline
    for (const [sid, tSess] of targetMap.entries()) {
      if (!baseMap.has(sid)) {
        added.push({
          sessionId: sid,
          day: tSess.day,
          startPeriod: tSess.start_period,
          roomId: tSess.room_id,
        });
      } else {
        const bSess = baseMap.get(sid)!;
        const timeDiff = bSess.day !== tSess.day || bSess.start_period !== tSess.start_period;
        const roomDiff = bSess.room_id !== tSess.room_id;

        if (timeDiff) {
          updatedTime.push({
            sessionId: sid,
            from: { day: bSess.day, startPeriod: bSess.start_period, roomId: bSess.room_id },
            to: { day: tSess.day, startPeriod: tSess.start_period, roomId: tSess.room_id },
          });
        } else if (roomDiff) {
          updatedRoom.push({
            sessionId: sid,
            day: tSess.day,
            startPeriod: tSess.start_period,
            fromRoom: bSess.room_id,
            toRoom: tSess.room_id,
          });
        } else {
          unchanged.push({
            sessionId: sid,
            day: tSess.day,
            startPeriod: tSess.start_period,
            roomId: tSess.room_id,
          });
        }
      }
    }

    // Check for removed sessions
    for (const [sid, bSess] of baseMap.entries()) {
      if (!targetMap.has(sid)) {
        removed.push({
          sessionId: sid,
          day: bSess.day,
          startPeriod: bSess.start_period,
          roomId: bSess.room_id,
        });
      }
    }

    return {
      baselineVersionId: baseline.id,
      targetVersionId: target.id,
      generatedAt: new Date().toISOString(),
      addedSessions: added,
      removedSessions: removed,
      updatedTimeSessions: updatedTime,
      updatedRoomSessions: updatedRoom,
      unchangedSessions: unchanged,
      summary: {
        totalBaseline: baseline.sessions.length,
        totalTarget: target.sessions.length,
        addedCount: added.length,
        removedCount: removed.length,
        timeChangedCount: updatedTime.length,
        roomOnlyChangedCount: updatedRoom.length,
        unchangedCount: unchanged.length,
      },
    };
  }

  /**
   * Generates Google Calendar Event models for approved timetable sessions.
   * Enforces approval safety: throws if schedule is not approved.
   */
  public static generateCalendarEvents(
    schedule: ScheduleVersion,
    filter?: {
      studentGroupId?: string;
      facultyId?: string;
    },
    providedDataset?: any
  ): Promise<GoogleCalendarEventModel[]> {
    if (schedule.status !== 'approved') {
      throw new Error(
        `Safety violation: Calendar events can only be generated for approved schedules. Schedule '${schedule.id}' is '${schedule.status}'.`
      );
    }

    return (async () => {
      const dataset = providedDataset || (await storage.getDataset());
      const sessionsMetadata = new Map((dataset.sessions || []).map((s: any) => [s.id, s]));
      const roomsMap = new Map((dataset.rooms || []).map((r: any) => [r.id, r]));
      const facultyMap = new Map((dataset.faculty || []).map((f: any) => [f.id, f]));

      const events: GoogleCalendarEventModel[] = [];

      for (const item of schedule.sessions) {
        const meta: any = sessionsMetadata.get(item.session_id);
        if (!meta) continue;

        // Filter by group if requested
        if (filter?.studentGroupId && !meta.groups.includes(filter.studentGroupId)) {
          continue;
        }
        // Filter by faculty if requested
        if (filter?.facultyId && meta.faculty_id !== filter.facultyId) {
          continue;
        }

        const dur = meta.duration || 1;
        const startP = item.start_period;
        const endP = startP + dur - 1;

        const dateStr = DAY_OFFSETS[item.day] || '2027-02-01';
        const startTimeStr = PERIOD_TIMES[startP]?.start || '09:00:00';
        const endTimeStr = PERIOD_TIMES[endP]?.end || '10:00:00';

        const room: any = roomsMap.get(item.room_id);
        const fac: any = facultyMap.get(meta.faculty_id);

        const stableId = `cit_session_${item.session_id.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const iCalUID = `cit-session-${item.session_id}@cit.ac.in`;

        events.push({
          id: stableId,
          iCalUID,
          summary: `${meta.course_id} ${meta.kind.toUpperCase()} (${meta.groups.join(', ')})`,
          description: `Course: ${meta.course_id} | Kind: ${meta.kind} | Faculty: ${fac?.name || meta.faculty_id} | Groups: ${meta.groups.join(', ')}`,
          location: `${room?.name || item.room_id} (${room?.building || 'Main Campus'}, Capacity: ${room?.capacity || 'N/A'})`,
          start: {
            dateTime: `${dateStr}T${startTimeStr}+05:30`,
            timeZone: 'Asia/Kolkata',
          },
          end: {
            dateTime: `${dateStr}T${endTimeStr}+05:30`,
            timeZone: 'Asia/Kolkata',
          },
          status: 'confirmed',
          extendedProperties: {
            private: {
              citSessionId: item.session_id,
              citCourseId: meta.course_id,
              citScheduleVersion: schedule.id,
              citDay: item.day,
              citStartPeriod: item.start_period,
              citRoomId: item.room_id,
            },
          },
        });
      }

      return events;
    })();
  }
}
