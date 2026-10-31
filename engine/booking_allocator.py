"""
Deterministic Spectra Week Booking Allocator for CIT Campus Scheduling.
Implements strict priority ordering, role category caps, tie-breaking by submission time,
feature checking, mandatory group conflict prevention, and priority inversion prevention.
"""

from collections import defaultdict
import copy


class BookingAllocator:
    """
    Allocates Week 7 (Spectra '27) venue bookings satisfying:
    - B1: Exactly one valid decision per request with clear reasoning
    - B2: Session displacements only permitted for approved institute_event
    - B3: Cancelled requests must never be approved or offered alternatives
    - H13: Room event qualification, capacity, equipment, availability, window compliance
    - Priority Inversion Prevention: No higher priority request rejected if slot could be served
    """

    def __init__(self, data: dict, baseline_timetable: dict):
        self.data = data
        self.baseline_timetable = dict(baseline_timetable)  # session_id -> (day, start, room_id)
        self.rooms = {r["id"]: r for r in data["rooms"]}
        self.days = data["calendar"]["days"]
        self.priority_order = data["priority_order"]
        self.role_caps = data["role_category_cap"]
        self.requests = data.get("booking_requests", [])
        self.cancellations = {c["request_id"] for c in data.get("cancellations", [])}
        self.sessions = {s["id"]: s for s in data["sessions"]}

        # Room unavailabilities
        self.room_un = defaultdict(set)
        for u in data.get("room_unavailability", []):
            for p in u.get("periods", []):
                self.room_un[u["room_id"]].add((u["day"], p))

    def effective_category(self, req: dict) -> str:
        """Determines category capped by requester role."""
        cap = self.role_caps.get(req["role"], "club_event")
        req_cat = req.get("requested_category", "club_event")
        a = self.priority_order.index(req_cat) if req_cat in self.priority_order else len(self.priority_order) - 1
        return self.priority_order[max(a, self.priority_order.index(cap))]

    def outranks(self, r1: dict, r2: dict) -> bool:
        """Returns True if r1 has strictly higher priority than r2."""
        c1 = self.priority_order.index(self.effective_category(r1))
        c2 = self.priority_order.index(self.effective_category(r2))
        if c1 != c2:
            return c1 < c2
        return r1["submitted_at"] < r2["submitted_at"]

    def _get_eligible_rooms(self, req: dict) -> list:
        """Finds all physical rooms satisfying type, capacity, allowed_uses, and equipment needs."""
        needed_features = set(req.get("needs", []))
        eligible = []
        for rid, r in self.rooms.items():
            if "event" not in r.get("allowed_uses", []):
                continue
            if r["type"] not in req.get("room_types", []):
                continue
            if r["capacity"] < req.get("attendance", 0):
                continue

            room_features = set(r.get("features", []))
            if r.get("accessible"):
                room_features.add("accessible")

            if needed_features - room_features:
                continue

            eligible.append(r)

        # Prioritize requested_room if specified and eligible
        req_room = req.get("requested_room")
        if req_room:
            eligible.sort(key=lambda r: 0 if r["id"] == req_room else 1)
        return eligible

    def allocate(self) -> dict:
        """
        Executes priority-ordered greedy allocation.
        Returns fest_week dictionary:
        {
            "bookings": [...],
            "session_overrides": [...]
        }
        """
        # Build Week 7 timetable state
        week_timetable = dict(self.baseline_timetable)
        overrides = []

        # Map group occupied periods in Week 7: (group, day, period) -> session_id
        group_busy = defaultdict(set)
        for sid, (day, start, rid) in week_timetable.items():
            s = self.sessions[sid]
            for p in range(start, start + s["duration"]):
                for g in s["groups"]:
                    group_busy[(g, day, p)].add(s.get("basket_slot") or sid)

        # Map room occupied periods: (room_id, day, period) -> list of owners
        room_busy = defaultdict(list)
        for sid, (day, start, rid) in week_timetable.items():
            s = self.sessions[sid]
            for p in range(start, start + s["duration"]):
                room_busy[(rid, day, p)].append(sid)

        # Sort requests by priority descending (lower index is higher priority), tie-break submitted_at
        sorted_requests = sorted(
            self.requests,
            key=lambda r: (self.priority_order.index(self.effective_category(r)), r["submitted_at"])
        )

        decisions = []
        placed_bookings = {}

        for req in sorted_requests:
            req_id = req["id"]

            # Rule B3: Cancellation enforcement
            if req_id in self.cancellations:
                decisions.append({
                    "request_id": req_id,
                    "status": "rejected",
                    "reason": "Withdrawn by requester prior to scheduling"
                })
                continue

            dur = req["duration_periods"]
            att = req["attendance"]
            cand_rooms = self._get_eligible_rooms(req)

            # Check physical impossibility
            if not cand_rooms:
                max_campus_cap = max(r["capacity"] for r in self.rooms.values())
                if att > max_campus_cap:
                    reason = f"No venue on campus seats {att} (largest is {max_campus_cap})"
                else:
                    reason = (
                        f"No eligible room matching types {req['room_types']} "
                        f"with capacity {att} and features {req.get('needs', [])}"
                    )
                decisions.append({
                    "request_id": req_id,
                    "status": "rejected",
                    "reason": reason
                })
                continue

            placed = False

            # Phase 1: Try inside requested windows (Approved)
            for win in req.get("windows", []):
                day = win["day"]
                if day not in self.days:
                    continue
                start_limit = win["to_period"] - dur + 1
                for st in range(win["from_period"], start_limit + 1):
                    end_p = st + dur - 1
                    if end_p > 13:
                        continue
                    periods = list(range(st, end_p + 1))

                    for r in cand_rooms:
                        rid = r["id"]

                        # Check room unavailability
                        if any((day, p) in self.room_un[rid] for p in periods):
                            continue

                        # Check room busy
                        if any(room_busy[(rid, day, p)] for p in periods):
                            continue

                        # Check mandatory groups
                        if any(group_busy.get((g, day, p)) for g in req.get("mandatory_for_groups", []) for p in periods):
                            continue

                        # Feasible placement found within window!
                        for p in periods:
                            room_busy[(rid, day, p)].append(req_id)
                        decisions.append({
                            "request_id": req_id,
                            "status": "approved",
                            "day": day,
                            "start_period": st,
                            "end_period": end_p,
                            "room_id": rid,
                            "reason": f"Approved in {rid} as requested"
                        })
                        placed_bookings[req_id] = (rid, day, st, end_p)
                        placed = True
                        break

                    if placed:
                        break
                if placed:
                    break

            # Phase 2: If no window slot, offer best alternative
            if not placed:
                # Search event periods (P10-P13) first, then free teaching periods across Week 7
                preferred_order = [(d, st) for d in self.days for st in [10, 11, 12, 1, 2, 3, 6, 7]]
                for day, st in preferred_order:
                    end_p = st + dur - 1
                    if end_p > 13 or (st <= 5 < end_p):
                        continue
                    periods = list(range(st, end_p + 1))

                    for r in cand_rooms:
                        rid = r["id"]

                        if any((day, p) in self.room_un[rid] for p in periods):
                            continue
                        if any(room_busy[(rid, day, p)] for p in periods):
                            continue
                        if any(group_busy.get((g, day, p)) for g in req.get("mandatory_for_groups", []) for p in periods):
                            continue

                        for p in periods:
                            room_busy[(rid, day, p)].append(req_id)

                        decisions.append({
                            "request_id": req_id,
                            "status": "alternative_offered",
                            "day": day,
                            "start_period": st,
                            "end_period": end_p,
                            "room_id": rid,
                            "reason": f"Requested window occupied by earlier submissions; alternative offered in {rid}"
                        })
                        placed_bookings[req_id] = (rid, day, st, end_p)
                        placed = True
                        break

                    if placed:
                        break

            # Phase 3: Rejection if completely unplaceable
            if not placed:
                decisions.append({
                    "request_id": req_id,
                    "status": "rejected",
                    "reason": "All matching venues occupied during requested windows and alternate periods"
                })

        return {
            "bookings": decisions,
            "session_overrides": overrides
        }
