#!/usr/bin/env python3
"""
Main deterministic scheduling coordinator for CIT Campus Scheduling.
Coordinates TimetableSolver, ExamScheduler, BookingAllocator, and DisruptionRepairer.
Generates compliant schedule.json and schedule_after.json exports.
"""

import argparse
import json
import os
import sys
import time

# Ensure engine package is importable
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from engine.timetable_solver import TimetableSolver
from engine.exam_scheduler import ExamScheduler
from engine.booking_allocator import BookingAllocator
from engine.disruption_repair import DisruptionRepairer


def generate_baseline_schedule(data: dict, team_name: str = "CIT Arch Team", seed: int = 42) -> dict:
    """
    Generates the complete baseline schedule including:
    - 189 teaching sessions
    - 41 midsem exams
    - 25 Spectra week bookings (with session overrides if applicable)
    """
    t0 = time.time()
    dataset_id = data.get("dataset_id", "cit-public-v1")

    # 1. Solve teaching timetable
    print(f"Solving teaching timetable for {len(data['sessions'])} sessions...")
    tt_solver = TimetableSolver(data, seed=seed)
    tt_assignment = tt_solver.solve()
    print(f"Teaching timetable solved in {time.time() - t0:.2f}s")

    # Convert assignment dict to list of dicts
    sessions_list = [
        {
            "session_id": sid,
            "day": slot[0],
            "start_period": slot[1],
            "room_id": slot[2]
        }
        for sid, slot in sorted(tt_assignment.items())
    ]

    # 2. Schedule exams
    t_exam = time.time()
    print(f"Scheduling {len(data.get('exams', []))} midsem exams...")
    exam_scheduler = ExamScheduler(data, seed=seed)
    exams_list = exam_scheduler.solve()
    print(f"Midsem exams scheduled in {time.time() - t_exam:.2f}s")

    # 3. Allocate Spectra week bookings
    t_book = time.time()
    print(f"Allocating {len(data.get('booking_requests', []))} Spectra week booking requests...")
    booking_allocator = BookingAllocator(data, tt_assignment)
    fest_week = booking_allocator.allocate()
    print(f"Bookings allocated in {time.time() - t_book:.2f}s")

    schedule = {
        "team": team_name,
        "dataset_id": dataset_id,
        "sessions": sessions_list,
        "fest_week": fest_week,
        "exams": exams_list
    }

    print(f"Full baseline schedule generation completed in {time.time() - t0:.2f}s")
    return schedule


def generate_disruption_schedule(data: dict, baseline_schedule: dict, disruption: dict) -> dict:
    """
    Repairs the timetable after applying disruption changes while locking
    unaffected sessions in place to minimize stability penalty.
    """
    t0 = time.time()
    print("Repairing schedule for disruption...")
    repairer = DisruptionRepairer(data, baseline_schedule["sessions"], disruption)
    repaired_sessions, stability = repairer.repair()
    print(f"Disruption repaired in {time.time() - t0:.2f}s")
    print(f"Stability: {stability['sessions_moved']} moved ({stability['time_changed']} time, {stability['room_only_changed']} room only)")

    schedule_after = {
        "team": baseline_schedule["team"],
        "dataset_id": baseline_schedule["dataset_id"],
        "sessions": repaired_sessions
    }
    return schedule_after, stability


def main():
    parser = argparse.ArgumentParser(description="CIT Campus Scheduling Engine")
    parser.add_argument("--data", default="starter_pack/CrunchWeek_StarterPack/data/cit_public.json", help="Path to cit_public.json")
    parser.add_argument("--disruption", default="starter_pack/CrunchWeek_StarterPack/examples/sample_disruption.json", help="Path to disruption JSON")
    parser.add_argument("--out-dir", default="exports", help="Directory to save exports")
    parser.add_argument("--team", default="CIT Arch Team", help="Team name for export")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for tie-breaking")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Generate baseline schedule.json
    baseline = generate_baseline_schedule(data, team_name=args.team, seed=args.seed)
    baseline_path = os.path.join(args.out_dir, "schedule.json")
    with open(baseline_path, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2)
    print(f"Saved baseline schedule to {baseline_path}")

    # Generate disrupted schedule_after.json if disruption provided
    if args.disruption and os.path.exists(args.disruption):
        with open(args.disruption, "r", encoding="utf-8") as f:
            disruption = json.load(f)
        schedule_after, stability = generate_disruption_schedule(data, baseline, disruption)
        after_path = os.path.join(args.out_dir, "schedule_after.json")
        with open(after_path, "w", encoding="utf-8") as f:
            json.dump(schedule_after, f, indent=2)
        print(f"Saved post-disruption schedule to {after_path}")


if __name__ == "__main__":
    main()
