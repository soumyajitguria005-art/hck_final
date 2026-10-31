"""
Comprehensive unit and integration test suite for CIT Campus Scheduling Engine.
Tests timetable solver, exam scheduler, booking allocator, disruption repair,
malformed input handling, and infeasible constraint diagnostic reporting.
"""

import copy
import json
import os
import sys
import unittest

# Ensure current directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.timetable_solver import TimetableSolver
from engine.exam_scheduler import ExamScheduler
from engine.booking_allocator import BookingAllocator
from engine.disruption_repair import DisruptionRepairer
import solver

# Import official validator for validation assertion
sys.path.append("starter_pack/CrunchWeek_StarterPack")
import validator


class TestCITCampusSchedulingEngine(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        data_path = "starter_pack/CrunchWeek_StarterPack/data/cit_public.json"
        with open(data_path, "r", encoding="utf-8") as f:
            cls.data = json.load(f)

        dis_path = "starter_pack/CrunchWeek_StarterPack/examples/sample_disruption.json"
        with open(dis_path, "r", encoding="utf-8") as f:
            cls.disruption = json.load(f)

    def test_01_timetable_solver_completeness_and_validity(self):
        """Verify timetable solver schedules all 189 sessions with 0 hard violations."""
        solver_obj = TimetableSolver(self.data, seed=42)
        assignment = solver_obj.solve()

        # All 189 sessions must be present
        self.assertEqual(len(assignment), len(self.data["sessions"]))

        # Validate with official validator
        ctx = validator.Ctx(self.data)
        violations, _ = validator.check_timetable(ctx, assignment, "timetable")
        self.assertEqual(len(violations), 0, f"Hard violations in timetable: {violations}")

        # Check soft score calculation
        soft_penalties, total = validator.soft_score(ctx, assignment)
        self.assertIsInstance(total, int)
        self.assertGreater(total, 0)
        self.assertIn("S1", soft_penalties)
        self.assertIn("S6", soft_penalties)

    def test_02_exam_scheduler_completeness_and_rules(self):
        """Verify exam scheduler schedules all 41 exams with half-capacity rule and no group clashes."""
        scheduler = ExamScheduler(self.data, seed=42)
        exams_out = scheduler.solve()

        # All 41 exams scheduled exactly once
        self.assertEqual(len(exams_out), len(self.data["exams"]))
        exam_ids = [e["exam_id"] for e in exams_out]
        self.assertEqual(len(exam_ids), len(set(exam_ids)))

        # Validate with official validator
        ctx = validator.Ctx(self.data)
        violations, soft_pen = validator.check_exams(ctx, exams_out)
        self.assertEqual(len(violations), 0, f"Hard violations in exams: {violations}")
        self.assertEqual(soft_pen, 0, f"Expected 0 soft exam penalty, got {soft_pen}")

    def test_03_booking_allocator_priorities_and_cancellations(self):
        """Verify booking allocator respects priority caps, cancellations, and has 0 inversions."""
        # Use verified timetable
        tt_solver = TimetableSolver(self.data, seed=42)
        tt_assignment = tt_solver.solve()

        allocator = BookingAllocator(self.data, tt_assignment)
        fest = allocator.allocate()

        decisions = fest["bookings"]
        self.assertEqual(len(decisions), len(self.data["booking_requests"]))

        # Verify BR-04 (cancelled) was rejected
        br04_dec = next(d for d in decisions if d["request_id"] == "BR-04")
        self.assertEqual(br04_dec["status"], "rejected")
        self.assertIn("Withdrawn", br04_dec["reason"])

        # Verify BR-09 (1200 attendance) was rejected
        br09_dec = next(d for d in decisions if d["request_id"] == "BR-09")
        self.assertEqual(br09_dec["status"], "rejected")

        # Validate with official validator
        ctx = validator.Ctx(self.data)
        bv, bw, bstats = validator.check_bookings(ctx, tt_assignment, fest)
        self.assertEqual(len(bv), 0, f"Booking hard violations: {bv}")
        self.assertEqual(len(bstats["priority_inversions"]), 0, f"Priority inversions found: {bstats['priority_inversions']}")
        self.assertGreater(bstats["booking_score"], 60.0)

    def test_04_disruption_repair_minimal_movement(self):
        """Verify disruption repair locks unaffected sessions and achieves minimal moves with 0 violations."""
        baseline_sched = solver.generate_baseline_schedule(self.data, seed=42)
        repaired_sched, stability = solver.generate_disruption_schedule(
            self.data, baseline_sched, self.disruption
        )

        # Mutated data has +1 session (CS202-T2) -> 190 sessions total
        self.assertEqual(len(repaired_sched["sessions"]), 190)

        # Validate stability: unaffected sessions must be kept locked
        # Only ~10 sessions should move (the ones directly touching F07 or CR-102)
        self.assertLessEqual(stability["sessions_moved"], 12)
        self.assertGreater(stability["room_only_changed"], 0)

        # Run official validator on disrupted schedule
        dis_data = validator.apply_disruption(self.data, self.disruption)
        rep = validator.run(
            dis_data,
            repaired_sched,
            baseline=baseline_sched
        )
        self.assertEqual(rep["hard_violation_count"], 0, f"Hard violations in disruption repair: {rep['hard_violations']}")

    def test_05_infeasible_constraint_diagnostic_reporting(self):
        """Verify solver raises descriptive RuntimeError when a session is mathematically infeasible."""
        bad_data = copy.deepcopy(self.data)
        # Add an impossible session: size 2000 students (largest room is 800)
        impossible_session = {
            "id": "IMPOSSIBLE-01",
            "course_id": "IMPOSSIBLE",
            "kind": "lecture",
            "groups": ["Y1-A"],
            "faculty_id": "F01",
            "size": 2000,
            "duration": 1,
            "room_types": ["classroom", "lecture_hall"],
            "needs_accessible": False,
            "basket_slot": None,
            "fixed_slot": None
        }
        bad_data["sessions"].append(impossible_session)

        solver_obj = TimetableSolver(bad_data)
        with self.assertRaises(RuntimeError) as ctx:
            solver_obj.solve()

        self.assertIn("Infeasible session IMPOSSIBLE-01", str(ctx.exception))
        self.assertIn("0 valid slots found", str(ctx.exception))

    def test_06_malformed_input_unknown_faculty(self):
        """Verify solver handles missing or malformed faculty gracefully."""
        bad_data = copy.deepcopy(self.data)
        bad_data["sessions"][0]["faculty_id"] = "NON_EXISTENT_FACULTY_XYZ"

        with self.assertRaises(KeyError):
            TimetableSolver(bad_data)


if __name__ == "__main__":
    unittest.main()
