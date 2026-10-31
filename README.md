# CIT Campus Scheduling and Venue Management

Automated, clash-free academic timetable generation, examination scheduling, Spectra week venue booking allocation, and minimal-disruption rescheduling for Chilika Institute of Technology (CIT).

---

## 1. System Architecture

The application is structured into a multi-tier, full-stack architecture:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Vite + React 19 Frontend                        │
│ ┌───────────────────┐ ┌───────────────────┐ ┌────────────────────────┐ │
│ │ Timetable Grid    │ │ Spectra Bookings  │ │ Disruption Simulator   │ │
│ │ (Faculty/Group/Rm)│ │ & AI Assistant    │ │ & Stability Diff       │ │
│ └───────────────────┘ └───────────────────┘ └────────────────────────┘ │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ REST API (JSON)
┌────────────────────────────────────▼───────────────────────────────────┐
│                 Express Backend (server.ts / Node.js)                  │
│  - Role-Based Access Control (Admin, Coordinator, Faculty, Club, Stu)  │
│  - Self-Approval Prevention Guardrails                                 │
│  - Atomic File Persistence & Schedule Versioning (data/storage/)       │
│  - Google Calendar Change Detection & RFC 5545 Mapping Engine          │
│  - Audit Logging & Version History                                     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Controlled Subprocess (Safe args)
┌────────────────────────────────────▼───────────────────────────────────┐
│         Deterministic Python 3 Engine (Standard Library Core)          │
│  - Timetable Solver (CSP + MRV + Synchronized Elective Baskets)        │
│  - Exam Scheduler (Graph Coloring + Half-Capacity Venue Bin-Packing)   │
│  - Spectra Booking Allocator (Priority-Ordered, Zero Inversions)       │
│  - Disruption Repairer (Minimal Moves, Room-Only Priority)             │
│  - Official validator.py Runner & Diagnostic Reporter                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Requirements & Setup

### Python Environment Requirements
- **Runtime:** Python 3.8+ (tested on Python 3.10.12).
- **Dependencies:** Standard library only (`json`, `collections`, `random`, `subprocess`, `sys`, `time`, `copy`, `itertools`, `unittest`).
- **External Packages:** Zero external pip dependencies required. Works out of the box in restricted environments.

### Node.js & Full-Stack Requirements
- **Runtime:** Node.js 18+ (tested on v22.23.4).
- **Package Manager:** npm or bun.
- **Key Dependencies:** Express 4.21, React 19, Vite 8, tsx 4.21.

### Installation & Startup Commands
```bash
# 1. Install Node.js dependencies
npm install

# 2. Run in Development Mode (Express API + Vite HMR on Port 3000)
npm run dev

# 3. Production Build and Start
npm run build
npm start
```

---

## 3. API Endpoint Documentation

| Method | Endpoint | Description | Permitted Roles |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Service health, Python engine & official validator readiness | Public / All |
| `GET` | `/api/dataset` | Summary or full CIT dataset (`cit_public.json`) | All roles |
| `GET` | `/api/dataset/rooms` | Query rooms filtered by type or capacity | All roles |
| `GET` | `/api/dataset/faculty` | Query faculty list and unavailabilities | All roles |
| `GET` | `/api/dataset/groups` | List all 14 student groups | All roles |
| `GET` | `/api/dataset/sessions` | List all 189 teaching sessions | All roles |
| `POST`| `/api/dataset/validate`| Validate schema of an imported dataset payload | All roles |
| `PUT` | `/api/dataset/room/:id`| Update permitted room features/accessibility | `admin` |
| `GET` | `/api/timetable` | Get active approved or proposed timetable with filters (`?group=`, `?faculty=`, `?room=`, `?day=`) | All roles |
| `GET` | `/api/timetable/versions` | List all schedule versions with validator status | All roles |
| `GET` | `/api/timetable/session/:id` | Single session lookup by stable ID | All roles |
| `POST`| `/api/timetable/generate` | Trigger deterministic Python solver & validator | `admin` |
| `POST`| `/api/timetable/:id/approve` | Promote proposed timetable to active approved version | `admin` |
| `GET` | `/api/exams` | Midsem examination schedule with half-capacity rooms | All roles |
| `GET` | `/api/bookings` | List Spectra week booking requests and allocation decisions | All roles |
| `POST`| `/api/bookings` | Submit new booking request (auto-caps category by role) | `admin`, `coordinator`, `faculty`, `club` |
| `GET` | `/api/bookings/:id` | Single booking request details and decision rationale | All roles |
| `POST`| `/api/bookings/:id/decision` | Approve or reject a booking (enforces self-approval guard) | `admin` |
| `GET` | `/api/disruptions` | List disruption scenarios and repair proposals | All roles |
| `POST`| `/api/disruptions/propose` | Inject disruption, run repair engine, compute session diff | `admin`, `coordinator` |
| `GET` | `/api/disruptions/:id` | Disruption details, stability metrics, and change diff | All roles |
| `POST`| `/api/disruptions/:id/approve` | Approve repaired schedule and promote to active baseline | `admin` |
| `POST`| `/api/disruptions/:id/reject` | Reject proposed disruption scenario | `admin` |
| `GET` | `/api/calendar/preview` | Preview RFC 5545 / Google Calendar events for group/faculty | All roles |
| `GET` | `/api/calendar/changes` | Change report between schedule versions for calendar sync | All roles |
| `GET` | `/api/calendar/status` | Current Google Calendar connection & sync metadata | All roles |
| `GET` | `/api/audit-logs` | Immutable audit log of scheduling and approval decisions | `admin`, `coordinator` |

---

## 4. Scheduling & Validation Workflow

1. **Deterministic Timetable Generation:**
   - The engine bundles elective baskets (`OEB-1`, `OEB-2`, `OEB-3`) as composite multi-room macro-variables.
   - Constrained labs (3 periods, starting at P2 or P6) and large lectures are prioritized via MRV heuristics.
   - Soft penalties are minimized ($S_1$ faculty avoid preferences, $S_5$ room underutilization, $S_6$ period 9 avoidance).
2. **Official Validation:**
   - Every generated timetable is validated directly against the official `validator.py`.
   - Schedules with $>0$ hard violations are rejected and prevented from becoming the active approved timetable.
3. **Approval Lifecycle:**
   - `Generated Schedule` $\rightarrow$ `Validator Verification (0 Hard Violations)` $\rightarrow$ `Proposed Version` $\rightarrow$ `Admin Approval` $\rightarrow$ `Active Approved Schedule`.
4. **Self-Approval Prevention:**
   - Users cannot approve their own booking requests or disruption proposals. Server-side checks enforce `SELF_APPROVAL_FORBIDDEN`.

---

## 5. Disruption Management & Stability

- When room closures (e.g. `CR-102`) or faculty leaves (e.g. `F07`) occur:
  1. The repair engine locks all 177+ unaffected baseline sessions in their exact slots.
  2. Directly invalidated sessions first attempt **Room-Only Relocation** at the identical day and period to preserve student/faculty timetables.
  3. Only sessions with unavailable faculty (or unplaceable rooms) are granted minimal time shifts.
  4. The proposal is validated against the baseline and returned as a diff without overwriting the active schedule.

---

## 6. Google Calendar Integration Readiness

Prepared in Milestone 2 for activation in Milestone 3:
- **Stable Identifiers:** All sessions maintain immutable IDs (`session_id`).
- **RFC 5545 UIDs:** Standardized deterministic UIDs (`cit-session-{sessionId}@cit.ac.in`).
- **Change Detection:** Computes precise diffs (`added`, `removed`, `updated_time`, `updated_room`, `unchanged`).
- **Approval Safety Gate:** Calendar event feeds are strictly forbidden from generating from unapproved or proposed schedules (`schedule.status === 'approved'` required).

---

## 7. Testing Commands

```bash
# 1. Run Backend API & Integration Test Suite (53 assertions across 17 requirements)
npm test

# 2. Run Python Deterministic Engine Unit Tests
python3 -m unittest tests/test_engine.py

# 3. Run Standalone Official Validator on Baseline Exports
python3 starter_pack/CrunchWeek_StarterPack/validator.py \
  --data starter_pack/CrunchWeek_StarterPack/data/cit_public.json \
  --schedule exports/schedule.json

# 4. Run Standalone Official Validator on Disruption Exports
python3 starter_pack/CrunchWeek_StarterPack/validator.py \
  --data starter_pack/CrunchWeek_StarterPack/data/cit_public.json \
  --schedule exports/schedule_after.json \
  --disruption starter_pack/CrunchWeek_StarterPack/examples/sample_disruption.json \
  --baseline exports/schedule.json
```

---

## 8. Persistence & Deployment Considerations

- **Current Implementation:** Durable, file-backed atomic JSON store in `data/storage/` with temporary write-rename semantics (`writeJsonAtomic`) to avoid partial write corruption under concurrent requests.
- **Cloud Run Deployment Note:** Cloud Run container filesystems are ephemeral. State changes made dynamically in a live container are preserved in memory and container overlay during execution, but persist across restarts only when stored in persistent databases or committed to export files (`exports/`).
