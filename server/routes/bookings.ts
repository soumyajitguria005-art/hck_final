import { Router, Response } from 'express';
import { AuthenticatedRequest, assertNotSelfApproval, requireAuth, requireRole } from '../auth.js';
import { BookingRecord, storage } from '../storage.js';

const router = Router();

const ROLE_CATEGORY_CAP: Record<string, string> = {
  admin: 'institute_event',
  faculty: 'guest_lecture',
  department_coordinator: 'department_event',
  club: 'club_event',
};

const PRIORITY_ORDER = [
  'exam',
  'regular_session',
  'institute_event',
  'guest_lecture',
  'department_event',
  'club_event',
];

function calculateEffectiveCategory(role: string, requestedCategory: string): string {
  const cap = ROLE_CATEGORY_CAP[role] || 'club_event';
  const a = PRIORITY_ORDER.includes(requestedCategory)
    ? PRIORITY_ORDER.indexOf(requestedCategory)
    : PRIORITY_ORDER.length - 1;
  const capIdx = PRIORITY_ORDER.indexOf(cap);
  return PRIORITY_ORDER[Math.max(a, capIdx)];
}

router.get('/bookings', async (req: AuthenticatedRequest, res: Response) => {
  const allBookings = await storage.getAllBookings();
  let list = Object.values(allBookings);

  const statusFilter = req.query.status as string;
  const roleFilter = req.query.role as string;
  const roomFilter = req.query.room as string;

  if (statusFilter) {
    list = list.filter((b) => b.status === statusFilter);
  }
  if (roleFilter) {
    list = list.filter((b) => b.role === roleFilter);
  }
  if (roomFilter) {
    list = list.filter((b) => b.allocated_room === roomFilter);
  }

  // Sort by priority order, then submitted_at
  list.sort((a, b) => {
    const pA = PRIORITY_ORDER.indexOf(a.effective_category);
    const pB = PRIORITY_ORDER.indexOf(b.effective_category);
    if (pA !== pB) return pA - pB;
    return new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime();
  });

  res.json({
    success: true,
    count: list.length,
    stats: {
      total: list.length,
      approved: list.filter((b) => b.status === 'approved').length,
      alternative_offered: list.filter((b) => b.status === 'alternative_offered').length,
      rejected: list.filter((b) => b.status === 'rejected').length,
      pending: list.filter((b) => b.status === 'pending').length,
    },
    data: list,
  });
});

router.get('/bookings/:id', async (req: AuthenticatedRequest, res: Response) => {
  const booking = await storage.getBookingById(req.params.id);
  if (!booking) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Booking request ${req.params.id} not found` } });
    return;
  }
  res.json({ success: true, data: booking });
});

router.post('/bookings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const {
    title,
    attendance,
    duration_periods,
    windows,
    room_types,
    needs = [],
    requested_room = null,
    mandatory_for_groups = [],
    raw_text = '',
    requested_category,
  } = req.body;

  if (!title || !attendance || !duration_periods || !Array.isArray(windows) || windows.length === 0) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'Missing required booking fields (title, attendance, duration_periods, windows)' },
    });
    return;
  }

  const role = req.user!.role as any;
  const effectiveCategory = calculateEffectiveCategory(role, requested_category || 'club_event');
  const reqId = `BR-${Date.now().toString().slice(-4)}`;

  const newBooking: BookingRecord = {
    id: reqId,
    submitted_at: new Date().toISOString(),
    requester: req.user!.name,
    role: role === 'student' ? 'club' : role,
    requested_category: requested_category || 'club_event',
    effective_category: effectiveCategory,
    title,
    attendance: Number(attendance),
    duration_periods: Number(duration_periods),
    windows,
    room_types: Array.isArray(room_types) ? room_types : ['seminar_hall', 'lecture_hall', 'classroom'],
    needs,
    requested_room,
    mandatory_for_groups,
    raw_text,
    status: 'pending',
    created_by: req.user!.id,
  };

  await storage.saveBooking(newBooking);

  await storage.logAudit({
    user_id: req.user!.id,
    user_name: req.user!.name,
    role: req.user!.role,
    action: 'CREATE_BOOKING_REQUEST',
    resource_type: 'booking',
    resource_id: reqId,
    details: { title, attendance, effectiveCategory },
    status: 'success',
  });

  res.status(201).json({
    success: true,
    message: 'Booking request submitted successfully. Pending allocation.',
    data: newBooking,
  });
});

router.post('/bookings/:id/decision', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const booking = await storage.getBookingById(req.params.id);
  if (!booking) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Booking ${req.params.id} not found` } });
    return;
  }

  // Enforce self-approval prevention rule
  try {
    assertNotSelfApproval(req, booking.created_by);
  } catch (err: any) {
    res.status(err.status || 403).json({
      success: false,
      error: { code: err.code || 'SELF_APPROVAL_FORBIDDEN', message: err.message },
    });
    return;
  }

  const { status, reason, room_id, day, start_period, end_period } = req.body;
  if (!['approved', 'rejected', 'alternative_offered'].includes(status)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Status must be approved, rejected, or alternative_offered' } });
    return;
  }

  // If approving with specific room and slot, prevent conflicting double booking
  if (status === 'approved' && room_id && day && start_period && end_period) {
    const sp = Number(start_period);
    const ep = Number(end_period);

    // 1. Check against other approved bookings
    const allBookings = await storage.getAllBookings();
    for (const other of Object.values(allBookings)) {
      if (
        other.id !== booking.id &&
        other.status === 'approved' &&
        other.allocated_room === room_id &&
        other.allocated_day === day &&
        other.allocated_start_period &&
        other.allocated_end_period
      ) {
        if (sp <= other.allocated_end_period && ep >= other.allocated_start_period) {
          res.status(409).json({
            success: false,
            error: {
              code: 'DOUBLE_BOOKING_CONFLICT',
              message: `Room '${room_id}' is already booked on ${day} periods ${other.allocated_start_period}-${other.allocated_end_period} by booking ${other.id}.`,
            },
          });
          return;
        }
      }
    }

    // 2. Check against timetable sessions in approved schedule
    const approvedSchedule = await storage.getApprovedSchedule();
    if (approvedSchedule) {
      const clash = approvedSchedule.sessions.find(
        (s) => s.room_id === room_id && s.day === day && s.start_period >= sp && s.start_period <= ep
      );
      if (clash) {
        res.status(409).json({
          success: false,
          error: {
            code: 'TIMETABLE_ROOM_CONFLICT',
            message: `Room '${room_id}' is occupied by session '${clash.session_id}' on ${day} period ${clash.start_period}.`,
          },
        });
        return;
      }
    }
  }

  booking.status = status;
  booking.decision_reason = reason || `Manual decision by ${req.user!.name}`;
  booking.decided_by = req.user!.id;
  booking.decided_at = new Date().toISOString();

  if (room_id) booking.allocated_room = room_id;
  if (day) booking.allocated_day = day;
  if (start_period) booking.allocated_start_period = Number(start_period);
  if (end_period) booking.allocated_end_period = Number(end_period);

  await storage.saveBooking(booking);

  await storage.logAudit({
    user_id: req.user!.id,
    user_name: req.user!.name,
    role: req.user!.role,
    action: `BOOKING_${status.toUpperCase()}`,
    resource_type: 'booking',
    resource_id: booking.id,
    details: { reason, room_id, day },
    status: 'success',
  });

  res.json({
    success: true,
    message: `Booking ${booking.id} marked as ${status}`,
    data: booking,
  });
});

export default router;
