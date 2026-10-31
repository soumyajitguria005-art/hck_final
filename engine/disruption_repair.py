"""
Deterministic Minimal-Disruption Rescheduling Engine for CIT Campus Scheduling.
Repairs invalidated sessions caused by room closures, faculty leave, and curriculum additions
while locking unaffected sessions in place to minimize timetable instability.
"""

from collections import defaultdict
import copy


def apply_disruption(data: dict, disruption: dict) -> dict:
    """
    Applies disruption changes to the dataset, matching validator.py semantics.
    Supports: faculty_unavailable, room_unavailable, add_faculty, add_session, remove_session.
    """
    d = copy.deepcopy(data)
    fac = {f["id"]: f for f in d["faculty"]}

    for ch in disruption.get("changes", []):
        t = ch["type"]
        if t == "faculty_unavailable":
            for day in ch["days"]:
                fac[ch["faculty_id"]]["unavailable"].append({
                    "day": day,
                    "periods": ch["periods"],
                    "reason": ch.get("reason", "")
                })
        elif t == "room_unavailable":
            for day in ch["days"]:
                d["room_unavailability"].append({
                    "room_id": ch["room_id"],
                    "day": day,
                    "periods": ch["periods"],
                    "reason": ch.get("reason", "")
                })
        elif t == "add_faculty":
            d["faculty"].append(ch["faculty"])
            fac[ch["faculty"]["id"]] = ch["faculty"]
        elif t == "add_session":
            d["sessions"].append(ch["session"])
        elif t == "remove_session":
            d["sessions"] = [s for s in d["sessions"] if s["id"] != ch["session_id"]]
        else:
            raise ValueError(f"Unknown disruption change type: {t}")

    return d


class DisruptionRepairer:
    """
    Repairs a baseline timetable against disruption mutations.
    Preserves unaffected sessions, prioritizing room-only moves over time moves.
    """

    def __init__(self, data: dict, baseline_sessions: list, disruption: dict):
        self.original_data = data
        self.disruption = disruption
        # Build baseline mapping: session_id -> (day, start_period, room_id)
        self.baseline = {
            s["session_id"]: (s["day"], s["start_period"], s["room_id"])
            for s in baseline_sessions
        }

        # Apply disruption mutations to produce mutated dataset
        self.mutated_data = apply_disruption(data, disruption)
        self.rooms = {r["id"]: r for r in self.mutated_data["rooms"]}
        self.faculty = {f["id"]: f for f in self.mutated_data["faculty"]}
        self.sessions = {s["id"]: s for s in self.mutated_data["sessions"]}
        self.days = self.mutated_data["calendar"]["days"]
        self.lunch = self.mutated_data["calendar"]["lunch"]["after_period"]
        self.lab_starts = set(self.mutated_data["calendar"]["lab_start_periods"])

        # Recompute unavailabilities on mutated dataset
        self.fac_un = defaultdict(set)
        for f in self.mutated_data["faculty"]:
            for u in f.get("unavailable", []):
                for p in u.get("periods", []):
                    self.fac_un[f["id"]].add((u["day"], p))

        self.room_un = defaultdict(set)
        for u in self.mutated_data.get("room_unavailability", []):
            for p in u.get("periods", []):
                self.room_un[u["room_id"]].add((u["day"], p))

    def repair(self) -> tuple:
        """
        Executes minimal-displacement repair.
        Returns:
            repaired_schedule: list of dicts [{"session_id", "day", "start_period", "room_id"}]
            stability_report: dict with sessions_moved, time_changed, room_only_changed, moved_ids
        """
        # Step 1: Identify directly invalidated sessions
        invalidated = set()
        for sid, (day, start, rid) in self.baseline.items():
            if sid not in self.sessions:
                continue  # Removed session
            s = self.sessions[sid]
            f_id = s["faculty_id"]
            dur = s["duration"]
            periods = list(range(start, start + dur))

            # Conflict with faculty unavailability
            if any((day, p) in self.fac_un[f_id] for p in periods):
                invalidated.add(sid)
            # Conflict with room unavailability
            elif any((day, p) in self.room_un[rid] for p in periods):
                invalidated.add(sid)

        # Added sessions are also considered to be placed
        for sid in self.sessions:
            if sid not in self.baseline:
                invalidated.add(sid)

        # Step 2: Lock unaffected baseline sessions
        locked = {}
        for sid, slot in self.baseline.items():
            if sid not in invalidated and sid in self.sessions:
                locked[sid] = slot

        # Build occupancy state from locked sessions
        room_occ = defaultdict(set)
        fac_occ = defaultdict(set)
        grp_occ = defaultdict(set)
        fac_day_hours = defaultdict(int)
        repaired = dict(locked)

        def can_assign(s, day, start, rid):
            dur = s["duration"]
            periods = list(range(start, start + dur))
            f_id = s["faculty_id"]
            mx = self.faculty[f_id].get("max_hours_per_day", 4)
            if fac_day_hours[(f_id, day)] + dur > mx:
                return False
            for p in periods:
                if (rid, day, p) in room_occ:
                    return False
                if (f_id, day, p) in fac_occ:
                    return False
                key = s.get("basket_slot") or s["id"]
                for g in s["groups"]:
                    if (g, day, p) in grp_occ:
                        if grp_occ[(g, day, p)] != {key}:
                            return False
            return True

        def do_assign(s, day, start, rid):
            dur = s["duration"]
            periods = list(range(start, start + dur))
            f_id = s["faculty_id"]
            repaired[s["id"]] = (day, start, rid)
            fac_day_hours[(f_id, day)] += dur
            key = s.get("basket_slot") or s["id"]
            for p in periods:
                room_occ[(rid, day, p)].add(s["id"])
                fac_occ[(f_id, day)] = fac_occ.get((f_id, day), set())
                fac_occ[(f_id, day, p)].add(s["id"])
                for g in s["groups"]:
                    grp_occ[(g, day, p)].add(key)

        for sid, (d, st, rid) in locked.items():
            s = self.sessions[sid]
            do_assign(s, d, st, rid)

        # Step 3: Phase 1 - Room-only relocation for invalidated sessions
        # (Preserves same day and start_period to keep stability high)
        sessions_to_repair = [self.sessions[sid] for sid in sorted(invalidated)]
        unresolved = []

        for s in sessions_to_repair:
            sid = s["id"]
            placed = False

            if sid in self.baseline:
                old_day, old_st, _ = self.baseline[sid]
                dur = s["duration"]
                periods = list(range(old_st, old_st + dur))

                # Check that faculty is actually free at the old slot
                if not any((old_day, p) in self.fac_un[s["faculty_id"]] for p in periods):
                    # Search alternative eligible rooms
                    for rid, r in self.rooms.items():
                        if r["type"] not in s["room_types"] or r["capacity"] < s["size"]:
                            continue
                        if s.get("needs_accessible") and not r["accessible"]:
                            continue
                        if any((old_day, p) in self.room_un[rid] for p in periods):
                            continue

                        if can_assign(s, old_day, old_st, rid):
                            do_assign(s, old_day, old_st, rid)
                            placed = True
                            break

            if not placed:
                unresolved.append(s)

        # Step 4: Phase 2 - Time-slot relocation for remaining sessions
        # Sort unresolved by lab first, then size descending
        unresolved.sort(key=lambda s: (0 if s["kind"] == "lab" else 1, -s["size"]))

        for s in unresolved:
            sid = s["id"]
            dur = s["duration"]
            f_id = s["faculty_id"]
            placed = False

            starts = [st for st in self.lab_starts if st + dur - 1 <= 9] if s["kind"] == "lab" else list(range(1, 10 - dur + 1))

            for day in self.days:
                for st in starts:
                    periods = list(range(st, st + dur))
                    if periods[0] <= self.lunch < periods[-1]:
                        continue
                    if any((day, p) in self.fac_un[f_id] for p in periods):
                        continue

                    for rid, r in self.rooms.items():
                        if r["type"] not in s["room_types"] or r["capacity"] < s["size"]:
                            continue
                        if s.get("needs_accessible") and not r["accessible"]:
                            continue
                        if any((day, p) in self.room_un[rid] for p in periods):
                            continue

                        if can_assign(s, day, st, rid):
                            do_assign(s, day, st, rid)
                            placed = True
                            break
                    if placed:
                        break
                if placed:
                    break

            if not placed:
                raise RuntimeError(
                    f"Disruption repair failed: unable to relocate session {sid} "
                    f"({s['course_id']}, kind={s['kind']}, size={s['size']}). "
                    f"All candidate time slots and venues conflict with current constraints."
                )

        # Step 5: Format output and calculate stability report
        repaired_list = [
            {"session_id": sid, "day": slot[0], "start_period": slot[1], "room_id": slot[2]}
            for sid, slot in sorted(repaired.items())
        ]

        # Calculate stability against baseline
        moved = [
            sid for sid in repaired
            if sid in self.baseline and sid in self.sessions and repaired[sid] != self.baseline[sid]
        ]
        time_changed = sum(1 for sid in moved if repaired[sid][:2] != self.baseline[sid][:2])
        room_only_changed = sum(1 for sid in moved if repaired[sid][:2] == self.baseline[sid][:2])

        stability = {
            "sessions_moved": len(moved),
            "time_changed": time_changed,
            "room_only_changed": room_only_changed,
            "moved_ids": sorted(moved)
        }

        return repaired_list, stability
