"""
Deterministic Midsem Exam Scheduler for CIT Campus Scheduling.
Allocates rooms at half capacity and prevents group exam clashes.
Optimizes soft penalty to ensure student groups have at most 1 exam per day.
"""

from collections import defaultdict
import random


class ExamScheduler:
    """
    Schedules all midsem exams into exam week slots satisfying:
    - E1: Every exam scheduled exactly once in a valid (day, session) slot
    - E2: All assigned rooms have "exam" in allowed_uses
    - H3: No student group has more than one exam in the same (day, session)
    - H4: No room is double-booked in the same (day, session)
    - H5: Total half-capacity seats sum >= exam size
    - Soft: Minimizes multiple exams on the same day for any group (+5 penalty per extra exam)
    """

    def __init__(self, data: dict, seed: int = 42):
        self.data = data
        self.seed = seed
        self.exams = data.get("exams", [])
        self.rooms = {r["id"]: r for r in data["rooms"]}
        self.cal = data["calendar"]["exam_week"]
        self.days = self.cal["days"]  # MON to SAT (6 days)
        self.sessions = [s["id"] for s in self.cal["sessions"]]  # AM, PM (2 sessions)

        # Candidate exam rooms (must allow "exam")
        self.exam_rooms = [
            r for r in data["rooms"]
            if "exam" in r.get("allowed_uses", []) and (r["capacity"] // 2) > 0
        ]
        # Sort rooms by half-capacity descending for efficient bin packing
        self.exam_rooms.sort(key=lambda r: r["capacity"] // 2, reverse=True)

        # 12 total exam slots: (day, session)
        self.slots = [(d, s) for d in self.days for s in self.sessions]

    def solve(self) -> list:
        """
        Assigns slots and rooms to all exams.
        Returns list of exam assignment dicts matching schedule.json schema:
        [{"exam_id": str, "day": str, "session": str, "rooms": [str, ...]}]
        """
        if not self.exams:
            return []

        rng = random.Random(self.seed)

        # Order exams by size descending, then group count descending
        sorted_exams = sorted(
            self.exams,
            key=lambda e: (e["size"], len(e["groups"])),
            reverse=True
        )

        assigned_exams = []
        grp_slots = defaultdict(set)
        room_slots = defaultdict(set)
        grp_days = defaultdict(set)

        for ex in sorted_exams:
            eid = ex["id"]
            needed_seats = ex["size"]
            groups = ex["groups"]

            candidate_slots = []

            for d, sess in self.slots:
                # Rule H3 check: group conflict in slot
                if any((g, d, sess) in grp_slots for g in groups):
                    continue

                # Room allocation check: find unused exam rooms in this slot
                chosen_rooms = []
                seats_accum = 0
                for r in self.exam_rooms:
                    rid = r["id"]
                    if (rid, d, sess) not in room_slots:
                        chosen_rooms.append(rid)
                        seats_accum += r["capacity"] // 2
                        if seats_accum >= needed_seats:
                            break

                # Rule H5 check: sufficient seating
                if seats_accum >= needed_seats:
                    # Soft cost: number of groups already having an exam on day d
                    day_conflict_cost = sum(1 for g in groups if (g, d) in grp_days)
                    # Secondary cost: seat over-provisioning
                    overprovision = seats_accum - needed_seats
                    candidate_slots.append((day_conflict_cost, overprovision, d, sess, chosen_rooms))

            if not candidate_slots:
                raise RuntimeError(
                    f"Exam scheduler failed: cannot place exam {eid} (size {needed_seats}, groups {groups}). "
                    f"No available slot satisfies group non-clash and half-capacity venue requirements."
                )

            # Sort by least soft penalty, then minimal seat waste
            candidate_slots.sort(key=lambda c: (c[0], c[1]))
            best_cost, best_waste, best_day, best_sess, best_rooms = candidate_slots[0]

            assigned_exams.append({
                "exam_id": eid,
                "day": best_day,
                "session": best_sess,
                "rooms": best_rooms
            })

            # Commit slot allocations
            for g in groups:
                grp_slots[(g, best_day, best_sess)].add(eid)
                grp_days[(g, best_day)].add(eid)
            for rid in best_rooms:
                room_slots[(rid, best_day, best_sess)].add(eid)

        return assigned_exams
