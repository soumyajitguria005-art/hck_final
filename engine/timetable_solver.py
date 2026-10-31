"""
Deterministic Teaching Timetable Solver for CIT Campus Scheduling.
Uses Constraint Satisfaction with domain pruning, MRV heuristics, and basket synchronization.
Runs entirely on Python 3 standard library with zero external dependencies.
"""

from collections import defaultdict
import copy
import random
import time


def block(start: int, dur: int):
    """Return list of period integers occupied by a session starting at start."""
    return list(range(start, start + dur))


class TimetableSolver:
    """
    Solves weekly teaching timetable for all sessions satisfying:
    - H1: Complete assignment, valid days/periods/rooms
    - H2: Faculty clash prevention
    - H3: Student group clash prevention (except shared basket slot)
    - H4: Room clash prevention
    - H5: Room capacity sufficient for session size
    - H6: Room type matches session allowed room types
    - H7: Faculty unavailability respected
    - H8: Room unavailability respected
    - H9: Period boundaries 1..9, no lunch crossing (P5-P6), lab start at P2 or P6
    - H10: Accessibility requirement respected
    - H11: Synchronized elective basket slots (same day & period, distinct rooms)
    - H12: Faculty daily maximum hours limit respected
    - H14: Fixed slot requirement respected
    """

    def __init__(self, data: dict, seed: int = 42):
        self.data = data
        self.seed = seed
        self.days = data["calendar"]["days"]
        self.lunch = data["calendar"]["lunch"]["after_period"]
        self.lab_starts = set(data["calendar"]["lab_start_periods"])
        self.rooms = {r["id"]: r for r in data["rooms"]}
        self.faculty = {f["id"]: f for f in data["faculty"]}
        self.student_groups = {g["id"]: g for g in data["student_groups"]}
        self.sessions = {s["id"]: s for s in data["sessions"]}

        # Faculty unavailabilities: faculty_id -> set of (day, period)
        self.fac_un = defaultdict(set)
        for f in data["faculty"]:
            for u in f.get("unavailable", []):
                for p in u.get("periods", []):
                    self.fac_un[f["id"]].add((u["day"], p))

        # Room unavailabilities: room_id -> set of (day, period)
        self.room_un = defaultdict(set)
        for u in data.get("room_unavailability", []):
            for p in u.get("periods", []):
                self.room_un[u["room_id"]].add((u["day"], p))

        # Faculty preferences: faculty_id -> list of avoid preferences
        self.fac_prefs = {f["id"]: f.get("preferences", []) for f in data["faculty"]}

        # Group sessions by basket
        self.baskets = defaultdict(list)
        for s in data["sessions"]:
            b = s.get("basket_slot")
            if b:
                self.baskets[b].append(s)

        # Precompute individual candidate domains
        self.session_candidates = self._precompute_candidates()

    def _precompute_candidates(self) -> dict:
        """Precomputes legal (day, start_period, room_id) tuples for each session."""
        cands = {}
        for sid, s in self.sessions.items():
            f_id = s["faculty_id"]
            dur = s["duration"]
            fx = s.get("fixed_slot")
            session_list = []

            # Determine candidate start periods
            if s["kind"] == "lab":
                allowed_starts = [st for st in self.lab_starts if st + dur - 1 <= 9]
            else:
                allowed_starts = list(range(1, 10 - dur + 1))

            for day in self.days:
                if fx and fx.get("day") != day:
                    continue

                for st in allowed_starts:
                    if fx and fx.get("start_period") != st:
                        continue

                    per = block(st, dur)
                    # Check lunch crossing (lunch is after period 5)
                    if per[0] <= self.lunch < per[-1]:
                        continue

                    # Check faculty unavailability
                    if any((day, p) in self.fac_un[f_id] for p in per):
                        continue

                    # Check valid rooms
                    for rid, r in self.rooms.items():
                        if r["type"] not in s["room_types"]:
                            continue
                        if r["capacity"] < s["size"]:
                            continue
                        if s.get("needs_accessible") and not r["accessible"]:
                            continue
                        if self.faculty[f_id].get("needs_accessible") and not r["accessible"]:
                            continue
                        if any((day, p) in self.room_un[rid] for p in per):
                            continue

                        session_list.append((day, st, rid))

            cands[sid] = session_list
        return cands

    def _score_candidate(self, s: dict, day: str, start: int, rid: str, current_grp_day_course: dict) -> float:
        """
        Calculates heuristic soft penalty for a candidate assignment.
        Lower score is better.
        """
        penalty = 0.0
        dur = s["duration"]
        per = block(start, dur)
        r = self.rooms[rid]
        f_id = s["faculty_id"]

        # S1: Faculty avoid preference (+2 per hour)
        for pref in self.fac_prefs.get(f_id, []):
            if pref.get("type") == "avoid" and day in pref.get("days", self.days):
                for p in per:
                    if p in pref.get("periods", []):
                        penalty += 2.0

        # S5: Room underutilization (<40% full costs +1)
        if r["capacity"] > 0 and (s["size"] / r["capacity"]) < 0.40:
            penalty += 1.0

        # S6: Period 9 class costs +1
        if 9 in per:
            penalty += 1.0

        # S4: Repetitive lecture of same course for a group on the same day (+3)
        if s["kind"] == "lecture" and not s.get("basket_slot"):
            cid = s["course_id"]
            for g in s["groups"]:
                if current_grp_day_course[(g, day, cid)] >= 1:
                    penalty += 3.0

        return penalty

    def solve(self, max_restarts: int = 20, max_steps: int = 30000) -> dict:
        """
        Executes randomized CSP search with domain-aware restarts.
        Returns mapping: session_id -> (day, start_period, room_id).
        Raises RuntimeError with detailed diagnostic if unsolvable.
        """
        # Validate that all sessions have non-empty domains
        for sid, cands in self.session_candidates.items():
            if not cands:
                s = self.sessions[sid]
                raise RuntimeError(
                    f"Infeasible session {sid} ({s['course_id']}): 0 valid slots found. "
                    f"Kind={s['kind']}, Size={s['size']}, RoomTypes={s['room_types']}, NeedsAccessible={s.get('needs_accessible')}."
                )

        rng = random.Random(self.seed)

        # Prepare basket variables
        basket_keys = sorted(self.baskets.keys())

        # Sort non-basket sessions by hardness:
        # 1. Labs (duration 3, restricted start periods and lab rooms)
        # 2. Large sessions (size >= 100)
        # 3. Fewest remaining candidate slots (MRV)
        non_basket_sessions = [s for s in self.sessions.values() if not s.get("basket_slot")]

        def variable_priority(s):
            is_lab = 0 if s["kind"] == "lab" else 1
            is_large = 0 if s["size"] >= 100 else 1
            domain_size = len(self.session_candidates[s["id"]])
            return (is_lab, is_large, domain_size)

        non_basket_sessions.sort(key=variable_priority)

        for attempt in range(max_restarts):
            room_occ = defaultdict(set)
            fac_occ = defaultdict(set)
            grp_occ = defaultdict(set)
            fac_day_hours = defaultdict(int)
            grp_day_course = defaultdict(int)
            assignment = {}
            steps = 0

            def can_assign(s, day, start, rid):
                dur = s["duration"]
                per = block(start, dur)
                f = s["faculty_id"]
                mx = self.faculty[f].get("max_hours_per_day", 4)
                if fac_day_hours[(f, day)] + dur > mx:
                    return False
                for p in per:
                    if (rid, day, p) in room_occ:
                        return False
                    if (f, day, p) in fac_occ:
                        return False
                    key = s.get("basket_slot") or s["id"]
                    for g in s["groups"]:
                        if (g, day, p) in grp_occ:
                            # Must match same basket slot
                            if grp_occ[(g, day, p)] != {key}:
                                return False
                return True

            def do_assign(s, day, start, rid):
                dur = s["duration"]
                per = block(start, dur)
                f = s["faculty_id"]
                assignment[s["id"]] = (day, start, rid)
                fac_day_hours[(f, day)] += dur
                if s["kind"] == "lecture" and not s.get("basket_slot"):
                    for g in s["groups"]:
                        grp_day_course[(g, day, s["course_id"])] += 1
                key = s.get("basket_slot") or s["id"]
                for p in per:
                    room_occ[(rid, day, p)].add(s["id"])
                    fac_occ[(f, day, p)].add(s["id"])
                    for g in s["groups"]:
                        grp_occ[(g, day, p)].add(key)

            def do_unassign(s):
                day, start, rid = assignment.pop(s["id"])
                dur = s["duration"]
                per = block(start, dur)
                f = s["faculty_id"]
                fac_day_hours[(f, day)] -= dur
                if s["kind"] == "lecture" and not s.get("basket_slot"):
                    for g in s["groups"]:
                        grp_day_course[(g, day, s["course_id"])] -= 1
                key = s.get("basket_slot") or s["id"]
                for p in per:
                    room_occ[(rid, day, p)].discard(s["id"])
                    if not room_occ[(rid, day, p)]:
                        del room_occ[(rid, day, p)]
                    fac_occ[(f, day, p)].discard(s["id"])
                    if not fac_occ[(f, day, p)]:
                        del fac_occ[(f, day, p)]
                    for g in s["groups"]:
                        grp_occ[(g, day, p)].discard(key)
                        if not grp_occ[(g, day, p)]:
                            del grp_occ[(g, day, p)]

            # 1. Place baskets first (OEB-1, OEB-2, OEB-3)
            # Find candidate day/time/room-triplets for each basket
            def solve_baskets(b_idx):
                nonlocal steps
                if b_idx == len(basket_keys):
                    return True
                b_name = basket_keys[b_idx]
                b_sess = self.baskets[b_name]
                s0, s1, s2 = b_sess[0], b_sess[1], b_sess[2]

                # Find valid slots (day, start, r0, r1, r2)
                possible_slots = []
                for day in self.days:
                    for st in range(1, 10):
                        if st <= self.lunch < st:
                            continue
                        r0_list = [rid for d, s, rid in self.session_candidates[s0["id"]] if d == day and s == st]
                        r1_list = [rid for d, s, rid in self.session_candidates[s1["id"]] if d == day and s == st]
                        r2_list = [rid for d, s, rid in self.session_candidates[s2["id"]] if d == day and s == st]
                        for r0 in r0_list:
                            for r1 in r1_list:
                                if r1 == r0:
                                    continue
                                for r2 in r2_list:
                                    if r2 == r0 or r2 == r1:
                                        continue
                                    possible_slots.append((day, st, r0, r1, r2))

                rng.shuffle(possible_slots)

                for day, st, r0, r1, r2 in possible_slots:
                    steps += 1
                    if not can_assign(s0, day, st, r0):
                        continue
                    do_assign(s0, day, st, r0)
                    if not can_assign(s1, day, st, r1):
                        do_unassign(s0)
                        continue
                    do_assign(s1, day, st, r1)
                    if not can_assign(s2, day, st, r2):
                        do_unassign(s1)
                        do_unassign(s0)
                        continue
                    do_assign(s2, day, st, r2)

                    if solve_baskets(b_idx + 1):
                        return True

                    do_unassign(s2)
                    do_unassign(s1)
                    do_unassign(s0)
                return False

            if not solve_baskets(0):
                continue

            # 2. Backtracking search on non-basket sessions
            def solve_sessions(idx):
                nonlocal steps
                if steps > max_steps:
                    return False
                if idx == len(non_basket_sessions):
                    return True

                s = non_basket_sessions[idx]
                cands = list(self.session_candidates[s["id"]])

                # Sort candidates by soft penalty score + random jitter
                cands.sort(key=lambda c: self._score_candidate(s, c[0], c[1], c[2], grp_day_course) + rng.uniform(0, 0.5))

                for day, st, rid in cands:
                    steps += 1
                    if can_assign(s, day, st, rid):
                        do_assign(s, day, st, rid)
                        if solve_sessions(idx + 1):
                            return True
                        do_unassign(s)

                return False

            if solve_sessions(0) and len(assignment) == len(self.sessions):
                return assignment

        raise RuntimeError(
            f"Timetable solver failed to converge after {max_restarts} restarts. "
            f"Total sessions={len(self.sessions)}. Please inspect constraint bottlenecks."
        )
