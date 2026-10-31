#!/usr/bin/env python3
"""
Runs the official Crunch Week validator.py against baseline and disrupted schedules.
Generates exports/report.json and exports/report_after.json.
Returns non-zero exit code if any hard violations or priority inversions are detected.
"""

import argparse
import json
import os
import subprocess
import sys


def run_validator(data_path: str, schedule_path: str, disruption_path: str = None,
                  baseline_path: str = None, report_path: str = None, validator_path: str = None) -> tuple:
    """Executes validator.py as a subprocess and parses the report."""
    if validator_path is None:
        validator_path = "starter_pack/CrunchWeek_StarterPack/validator.py"

    cmd = [sys.executable, validator_path, "--data", data_path, "--schedule", schedule_path]
    if disruption_path:
        cmd.extend(["--disruption", disruption_path])
    if baseline_path:
        cmd.extend(["--baseline", baseline_path])
    if report_path:
        cmd.extend(["--json", report_path])

    print(f"\nExecuting: {' '.join(cmd)}")
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    print(result.stdout)
    if result.stderr:
        print("STDERR:", result.stderr, file=sys.stderr)

    report_data = None
    if report_path and os.path.exists(report_path):
        with open(report_path, "r", encoding="utf-8") as f:
            report_data = json.load(f)

    return result.returncode, report_data


def main():
    parser = argparse.ArgumentParser(description="Official Validator Runner")
    parser.add_argument("--data", default="starter_pack/CrunchWeek_StarterPack/data/cit_public.json")
    parser.add_argument("--baseline", default="exports/schedule.json")
    parser.add_argument("--after", default="exports/schedule_after.json")
    parser.add_argument("--disruption", default="starter_pack/CrunchWeek_StarterPack/examples/sample_disruption.json")
    parser.add_argument("--validator", default="starter_pack/CrunchWeek_StarterPack/validator.py")
    parser.add_argument("--reports-dir", default="exports")
    args = parser.parse_args()

    os.makedirs(args.reports_dir, exist_ok=True)
    baseline_report_path = os.path.join(args.reports_dir, "report.json")
    after_report_path = os.path.join(args.reports_dir, "report_after.json")

    # 1. Validate baseline schedule.json
    print("=================================================================")
    print("STEP 1: VALIDATING BASELINE SCHEDULE (schedule.json)")
    print("=================================================================")
    rc1, rep1 = run_validator(
        data_path=args.data,
        schedule_path=args.baseline,
        report_path=baseline_report_path,
        validator_path=args.validator
    )

    # 2. Validate disrupted schedule_after.json
    print("\n=================================================================")
    print("STEP 2: VALIDATING DISRUPTED SCHEDULE (schedule_after.json)")
    print("=================================================================")
    rc2, rep2 = run_validator(
        data_path=args.data,
        schedule_path=args.after,
        disruption_path=args.disruption,
        baseline_path=args.baseline,
        report_path=after_report_path,
        validator_path=args.validator
    )

    # Summary verification
    print("\n=================================================================")
    print("FINAL VALIDATION SUMMARY")
    print("=================================================================")
    baseline_hard = rep1.get("hard_violation_count", -1) if rep1 else -1
    baseline_soft = rep1.get("soft_total", -1) if rep1 else -1
    inversions = len(rep1.get("bookings", {}).get("priority_inversions", [])) if rep1 else -1

    after_hard = rep2.get("hard_violation_count", -1) if rep2 else -1
    after_moved = rep2.get("stability", {}).get("sessions_moved", -1) if rep2 else -1

    print(f"Baseline Schedule: Hard Violations = {baseline_hard}, Soft Total = {baseline_soft}, Inversions = {inversions}")
    print(f"Post-Disruption:  Hard Violations = {after_hard}, Sessions Moved = {after_moved}")

    if baseline_hard == 0 and after_hard == 0 and inversions == 0:
        print("\nSUCCESS: All official validation checks PASSED with 0 violations!")
        sys.exit(0)
    else:
        print("\nFAILURE: Official validation reported violations or errors!")
        sys.exit(1)


if __name__ == "__main__":
    main()
