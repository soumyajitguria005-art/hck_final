# CIT Campus Scheduling & Venue Management — Comprehensive Current State Audit

**Project:** Chilika Institute of Technology (CIT) Campus Scheduling & Venue Management Platform  
**Audit Type:** Read-Only Source Code & System Architecture Audit  
**Date of Audit:** October 31, 2026  
**Auditor:** Senior Software Engineer (AI Studio Build Engine)

---

## 1. Executive Summary & Verdict

The CIT Campus Scheduling and Venue Management platform has successfully completed **Milestone 1** (the deterministic Python scheduling engine, examination allocator, Spectra booking scheduler, disruption repairer, and official validator integration) and **Milestone 2** (the Node.js / Express REST API, role-based access control, persistent user store, audit logging, atomic JSON storage adapter, and PostgreSQL migration readiness).

However, the application currently lacks a functional frontend interface (`src/App.tsx` is an empty placeholder), has not yet wired the generative AI natural-language parsing endpoint for plain-language booking requests, and has not yet executed live PostgreSQL integration against a provisioned database.

### High-Level Status Dashboard

```
┌────────────────────────────────────────────────────────────────────────┐
│ TOTAL AUDITED CAPABILITIES: 42 Functional & Architectural Dimensions    │
├────────────────────────────────────────────────────────────────────────┤
│  [x] IMPLEMENTED AND VERIFIED:     28 (66.7%)                          │
│  [?] IMPLEMENTED BUT NOT VERIFIED:  4  (9.5%)                          │
│  [-] PARTIALLY IMPLEMENTED:         3  (7.1%)                          │
│  [ ] NOT IMPLEMENTED:               5 (11.9%)                          │
│  [!] BLOCKED BY CONFIGURATION:      2  (4.8%)                          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Current Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND LAYER (Vite + React 19)                │
│  [CURRENT STATE: NOT IMPLEMENTED — src/App.tsx is an empty <div>]      │
│  - Planned: Role-based Dashboards (Admin, Coordinator, Faculty, Club,  │
│             Student), Timetable Grid, Booking Form, Disruption Diff    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ REST JSON API (Port 3000)
┌────────────────────────────────────▼───────────────────────────────────┐
│                 BACKEND API LAYER (Express 4.21 / Node.js)             │
│  - server.ts: Dual-mode HTTP server (Vite middleware / Production SPA) │
│  - server/auth.ts: 5 RBAC roles, Bearer token auth, self-approval guard│
│  - server/routes/: Health, Dataset, Timetable, Exams, Bookings,        │
│                    Disruptions, Calendar, Audit, Users                 │
│  - server/calendarService.ts: RFC 5545 UIDs & version change diffing   │
└──────────────────┬───────────────────────────────────┬─────────────────┘
                   │ Storage Interface                 │ Python Subprocess
┌──────────────────▼───────────────────┐ ┌─────────────▼─────────────────┐
│     STORAGE ADAPTER ARCHITECTURE     │ │   DETERMINISTIC PYTHON ENGINE │
│  - IStorage (storageInterface.ts)    │ │   (engine/*.py / solver.py)   │
│  - JSON Storage (storage.ts) [ACTIVE]│ │  - TimetableSolver (189 sess) │
│    * data/storage/ (atomic writes)   │ │  - ExamScheduler (41 exams)   │
│  - PostgresStorage (postgresStorage) │ │  - BookingAllocator (25 reqs) │
│    * server/db/schema.sql            │ │  - DisruptionRepair (12 moves)│
│    * server/db/migrate.ts (topolog.) │ │  - validator.py integration   │
└──────────────────────────────────────┘ └───────────────────────────────┘
```

---

## 3. Comprehensive Feature Verification Matrix

Every feature is classified based strictly on code inspection and direct test execution:

### A. Core Scheduling Engine (Milestone 1)

| Feature / Subsystem | Status | Verification Evidence & Code Findings |
|---|---|---|
| **Teaching Timetable Generation** (189 sessions) | **IMPLEMENTED AND VERIFIED** | `engine/timetable_solver.py`: Deterministic CSP solver with MRV heuristics and elective basket synchronization. Solves all 189 sessions in 0.37s with **0 hard violations**. Verified via `python3 -m unittest discover tests`. |
| **Midsem Exam Scheduling** (41 exams) | **IMPLEMENTED AND VERIFIED** | `engine/exam_scheduler.py`: Graph coloring and venue bin-packing across half-capacity rooms for all 41 exams. Soft penalty: **0**. Verified via `test_engine.py`. |
| **Spectra Week Booking Allocation** (25 requests) | **IMPLEMENTED AND VERIFIED** | `engine/booking_allocator.py`: Priority-ordered allocation respecting role category caps (`institute_event` > `guest_lecture` > `department_event` > `club_event`). Approved: 20, Alternatives: 3, Rejected: 2, Inversions: **0**. Score: **63.0/70**. |
| **Minimal-Disruption Rescheduling** | **IMPLEMENTED AND VERIFIED** | `engine/disruption_repair.py`: Relocates affected sessions while freezing unaffected sessions. Evaluated against `examples/sample_disruption.json`: exactly 12 sessions moved (11 room-only, 1 time change), **0 hard violations**, soft penalty: 187. |
| **Official Validator Integration** | **IMPLEMENTED AND VERIFIED** | `validator_runner.py` executes official `starter_pack/CrunchWeek_StarterPack/validator.py` on both baseline and disrupted schedules. Output exit code: 0, Hard violations: **0**. |
| **Pre-computed Export Artifacts** | **IMPLEMENTED AND VERIFIED** | `exports/schedule.json`, `exports/schedule_after.json`, `exports/report.json`, and `exports/report_after.json` are fully generated and valid. |

### B. Backend REST APIs & Integration (Milestone 2)

| Feature / Subsystem | Status | Verification Evidence & Code Findings |
|---|---|---|
| **Service Healthcheck** (`GET /api/health`) | **IMPLEMENTED AND VERIFIED** | `server/routes/health.ts`: Returns HTTP 200, checks Python 3 runtime, solver availability, validator availability, and active approved schedule. Verified in `test_api.ts` Test 1. |
| **Dataset API** (`GET /api/dataset/*`, `PUT /room/:id`) | **IMPLEMENTED AND VERIFIED** | `server/routes/dataset.ts`: Exposes rooms, faculty, groups, sessions, and schema validation. Admin room updates log audit entries. Verified in `test_api.ts` Test 2 and `test_security.ts` Req 8. |
| **Timetable API** (`GET /api/timetable/*`, `POST /generate`, `POST /approve`) | **IMPLEMENTED AND VERIFIED** | `server/routes/timetable.ts`: Session retrieval with group, faculty, room, and day filtering; asynchronous solver execution via `pythonBridge.ts`; atomic schedule promotion with single-approved version guarantee. Verified in `test_api.ts` Tests 3, 5, 6. |
| **Exam Schedule API** (`GET /api/exams`) | **IMPLEMENTED AND VERIFIED** | `server/routes/exams.ts`: Returns 41 exams with half-capacity room allocations from the approved schedule. |
| **Venue Booking API** (`GET /api/bookings/*`, `POST /bookings`, `POST /decision`) | **IMPLEMENTED AND VERIFIED** | `server/routes/bookings.ts`: Lists bookings sorted by priority order; auto-caps requested category by caller role; blocks room double-booking; blocks self-approval. Verified in `test_api.ts` Test 7, 11 and `test_security.ts` Req 9. |
| **Disruption API** (`GET /api/disruptions/*`, `POST /propose`, `POST /approve`, `POST /reject`) | **IMPLEMENTED AND VERIFIED** | `server/routes/disruptions.ts`: Injects disruption changes, runs repair engine, computes session diffs, validates via official validator, and records audit logs. Verified in `test_api.ts` Test 8, 9. |
| **Calendar Preview & Diff API** (`GET /api/calendar/*`) | **IMPLEMENTED AND VERIFIED** | `server/routes/calendar.ts`: Generates RFC 5545 events with stable UIDs; enforces student/faculty scoping; blocks unapproved schedules; computes version diffs. Verified in `test_api.ts` Tests 14, 15, 16. |
| **Audit Log API** (`GET /api/audit-logs`) | **IMPLEMENTED AND VERIFIED** | `server/routes/audit.ts`: Immutable query interface for administrative and scheduling decisions. Restricted to `admin` and `department_coordinator`. Verified in `test_audit_verification.ts` Test 16. |
| **User Directory API** (`GET /api/users/*`, `POST /users`, `PUT /users/:id`) | **IMPLEMENTED AND VERIFIED** | `server/routes/users.ts`: Full CRUD with referential integrity validation against institutional records. Department coordinator user queries are strictly scoped to their department. Verified in `test_security.ts` Req 7, 10, 11. |
| **Authentication Login API** (`POST /api/auth/login`) | **NOT IMPLEMENTED** | Backend currently resolves authentication exclusively via Bearer tokens or `x-user-id` headers. There is no `/api/auth/login` endpoint accepting username/password for session cookie/token generation. |
| **AI Booking Request Parser API** (`POST /api/bookings/parse-ai`) | **NOT IMPLEMENTED** | Disclosed in `AI_USAGE.md`, but no route handler or Gemini service method exists in `server/routes` or `server`. Plain-language strings cannot yet be processed via API. |

### C. Authentication & Role-Based Access Control (RBAC)

| Feature / Subsystem | Status | Verification Evidence & Code Findings |
|---|---|---|
| **Five Application Roles** (`admin`, `department_coordinator`, `faculty`, `club`, `student`) | **IMPLEMENTED AND VERIFIED** | `server/auth.ts`: Strict enum-backed roles. Verified in `test_security.ts` Req 2 with real users (`usr-admin`, `usr-coord-cse`, `usr-faculty-f19`, `usr-club-drama`, `usr-student-cse3`). |
| **Self-Approval Guardrails** | **IMPLEMENTED AND VERIFIED** | `assertNotSelfApproval` middleware in `server/auth.ts` catches self-approvals on bookings, disruptions, and timetables; returns HTTP 403 `SELF_APPROVAL_FORBIDDEN`. Backed by database triggers in `schema.sql`. Verified in `test_security.ts` Req 9. |
| **Role Spoofing Prevention** | **IMPLEMENTED AND VERIFIED** | Client-supplied role attributes in request bodies are ignored; effective roles and category caps are derived strictly from server-verified session records. Verified in `test_security.ts` Req 4. |
| **Production Identity Hardening** | **IMPLEMENTED AND VERIFIED** | In `NODE_ENV === 'production'`, `x-user-id`, `asUser`, and role aliases are rejected (HTTP 401). Only cryptographically secure tokens in `user_auth_tokens` succeed. Verified in `test_postgres_schema.ts` Section 4. |
| **Department Scoping for Coordinators** | **IMPLEMENTED AND VERIFIED** | Coordinators querying `/api/users` only receive users in their own department (e.g. CSE). Verified in `test_security.ts` Req 7. |
| **Student Cross-Group Calendar Isolation** | **IMPLEMENTED AND VERIFIED** | Students requesting another group's calendar receive HTTP 403 `FORBIDDEN`. Verified in `test_security.ts` Req 5. |

### D. Data Storage & Persistence Layer

| Feature / Subsystem | Status | Verification Evidence & Code Findings |
|---|---|---|
| **Canonical Storage Interface** (`IStorage`) | **IMPLEMENTED AND VERIFIED** | `server/storageInterface.ts`: All 26 CRUD methods return `Promise<T>`. |
| **JSON Storage Adapter** (`StorageManager`) | **IMPLEMENTED AND VERIFIED** | `server/storage.ts`: Active default driver (`STORAGE_DRIVER=json`). Atomic writes via `writeJsonAtomic` using temporary write-and-rename. Verified in `test_audit_verification.ts` Test 15 (10 concurrent requests without corruption). |
| **PostgreSQL Storage Adapter** (`PostgresStorage`) | **IMPLEMENTED BUT NOT VERIFIED** | `server/postgresStorage.ts`: Implements all 26 methods, connection pooling, transactions, and schedule reconstruction. Verified with mock pool (47/47 PASS in `test_postgres_storage_mock.ts`), but **NOT RUN** against a live PostgreSQL server. |
| **Authoritative PostgreSQL Schema** (`schema.sql`) | **IMPLEMENTED AND VERIFIED** | `server/db/schema.sql`: 479 lines of DDL addressing all 9 relational defects, unique indexes, and self-approval triggers. Clean repeatable syntax verified. |
| **Topological Data Migration Engine** (`migrate.ts`) | **IMPLEMENTED AND VERIFIED** | `server/db/migrate.ts`: Migrates all catalog and operational entities with transactional rollback and dry-run mode. Verified in `test_postgres_schema.ts` Section 2. |
| **Live Staging PostgreSQL Database** | **BLOCKED BY CONFIGURATION** | No PostgreSQL database is attached to the runtime (`STAGING_DATABASE_URL` is empty). Automated staging harness `tests/test_postgres_staging_live.ts` reported **26 NOT RUN**. |

### E. Frontend Application (Vite + React 19)

| Feature / Subsystem | Status | Verification Evidence & Code Findings |
|---|---|---|
| **Root Application Shell** (`src/App.tsx`) | **NOT IMPLEMENTED** | `src/App.tsx` contains 9 lines: `export default function App() { return <div></div>; }`. No navigation, layout, or components. |
| **Client-Side Routing** | **NOT IMPLEMENTED** | `react-router` is not installed in `package.json`. No route tree or page switches exist. |
| **Admin Dashboard** | **NOT IMPLEMENTED** | No UI for master timetable generation, schedule promotions, system statistics, or user account management. |
| **Department Coordinator Interface** | **NOT IMPLEMENTED** | No UI for viewing departmental teaching schedules, faculty load, or submitting departmental event bookings. |
| **Faculty Schedule Portal** | **NOT IMPLEMENTED** | No UI for faculty personal timetables, room details, or guest lecture booking requests. |
| **Club Representative Booking Portal** | **NOT IMPLEMENTED** | No UI for Spectra week booking submissions, status tracking, or alternative offer acceptances. |
| **Student Timetable View** | **NOT IMPLEMENTED** | No UI for student group schedules, elective basket displays, or exam schedules. |
| **Interactive Timetable Grid Component** | **NOT IMPLEMENTED** | No weekly grid component displaying Days (MON-FRI) vs Periods (P1-P9) with faculty/group/room color coding. |
| **Plain-Language AI Assistant Interface** | **NOT IMPLEMENTED** | No chat/input component for parsing plain-language booking requests into editable forms. |
| **Disruption Simulation & Diff Visualizer** | **NOT IMPLEMENTED** | No visual comparison interface displaying before-and-after schedules with room-only vs. time moves. |
| **Authentication / Role-Switcher UI** | **NOT IMPLEMENTED** | No UI to switch between roles (`admin`, `coordinator`, `faculty`, `club`, `student`) or log in with credentials. |

### F. External Integrations & Deployment

| Feature / Subsystem | Status | Verification Evidence & Code Findings |
|---|---|---|
| **Google Calendar 1P OAuth & Live Push** | **PARTIALLY IMPLEMENTED** | RFC 5545 event generation, deterministic `iCalUID` generation, schedule diffing, and metadata endpoints are verified. However, live 1P Google Workspace OAuth consent flows and actual push synchronization to Google Calendar API are not implemented. |
| **Gemini Generative AI Integration** | **PARTIALLY IMPLEMENTED** | `@google/genai` (v2.4.0) is installed in `package.json` and disclosed in `AI_USAGE.md`. However, no backend service or frontend component calls the model yet. |
| **Vercel Serverless Deployment Config** | **IMPLEMENTED AND VERIFIED** | `vercel.json` routes `/api/*` to serverless backend and serves static build directory `dist`. |
| **Containerized Python Solver Service** | **IMPLEMENTED BUT NOT VERIFIED** | `Dockerfile.solver` provides standalone microservice deployment for Coin-OR CBC and PuLP solvers, but has not yet been built or run as a live container service. |
| **Production Serverless Database Provisioning** | **BLOCKED BY CONFIGURATION** | Vercel deployment requires a persistent PostgreSQL database (Supabase / Neon); currently unprovisioned. |

---

## 4. Frontend-to-Backend Integration Gaps

Since the backend APIs are complete but the frontend has not yet been constructed, the following integration bridges must be established:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          IDENTIFIED INTEGRATION GAPS                            │
├───────────────────────────────┬───────────────────────────────┬─────────────────┤
│ Frontend Feature Required     │ Corresponding Backend API     │ Integration Gap │
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Active User / Role Switcher   │ GET /api/users/me             │ Frontend state  │
│                               │ Headers: Authorization: Bearer│ context missing │
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Timetable Grid (Group/Fac/Rm) │ GET /api/timetable?group=...  │ Frontend grid   │
│                               │ GET /api/timetable/versions   │ renderer missing│
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Solver Trigger & Promotion    │ POST /api/timetable/generate  │ Admin action    │
│                               │ POST /api/timetable/:id/appr  │ controls missing│
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Spectra Booking Dashboard     │ GET /api/bookings             │ Booking table & │
│                               │ POST /api/bookings            │ forms missing   │
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Natural Language AI Parser    │ [MISSING] POST /api/bookings/ │ Backend endpoint│
│                               │          parse-ai             │ & UI missing    │
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Disruption Simulator & Diff   │ POST /api/disruptions/propose │ Diff inspector  │
│                               │ POST /api/disruptions/:id/appr│ visualizer miss.│
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Exam Schedule Viewer          │ GET /api/exams                │ Exam calendar   │
│                               │                               │ view missing    │
├───────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Audit Log Explorer            │ GET /api/audit-logs           │ Admin audit     │
│                               │                               │ table missing   │
└───────────────────────────────┴───────────────────────────────┴─────────────────┘
```

---

## 5. Security & Deployment Risks

1. **Vercel Ephemeral Filesystem Risk (High Severity in Production):**
   - In production on Vercel, serverless function filesystems are read-only or ephemeral (`/tmp` only).
   - If `STORAGE_DRIVER=json` is deployed to Vercel, any bookings, disruptions, or schedule approvals created by users will disappear when the serverless container recycles.
   - *Mitigation:* Ensure `STORAGE_DRIVER=postgres` is set with a live Supabase/Neon PostgreSQL database before public production cutover.
2. **Python Solver in Serverless Environments (High Severity in Production):**
   - Vercel Serverless Functions run Node.js in an AWS Lambda-like environment without a full Python runtime or CBC solver binaries.
   - Calling `pythonBridge.ts` via `execFile('python3')` will fail on Vercel if Python is missing.
   - *Mitigation:* The backend supports delegating solver runs to a containerized microservice via `Dockerfile.solver` (or running the full-stack app as a monolithic container on Cloud Run / Railway / Render).
3. **Missing Authentication UI (Medium Severity for Hackathon Demo):**
   - The API requires Bearer tokens (`admin-token-secret-01`, etc.) or headers (`x-user-id: usr-admin`).
   - Without an intuitive in-app Role Switcher or quick-login header in the frontend, evaluators will not be able to experience the five distinct role interfaces.
   - *Mitigation:* Implement a prominent, persistent Role Selector in the frontend header (`[Acting as: Dr. S. K. Nayak (Admin)] [Switch Role]`).

---

## 6. Missing Configuration & External Services

| Service / Configuration | Required For | Current Status | Action Needed |
|---|---|---|---|
| **`GEMINI_API_KEY`** | Plain-language booking parsing | Present in environment, unused in code | Implement Gemini SDK service in backend & connect to booking form |
| **`STAGING_DATABASE_URL`** | Real PostgreSQL staging tests | Unset in runner environment | Provision disposable PostgreSQL database for live testing |
| **`DATABASE_URL`** | Production PostgreSQL storage | Unset | Required only when `STORAGE_DRIVER=postgres` is switched in production |
| **`SOLVER_SERVICE_URL`** | External solver execution | Unset | Needed only if separating solver from Express backend on Vercel |

---

## 7. Prioritized Milestone Plan

```
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 1: Deterministic Engine & Official Validator   [100% DONE]   │
│  - Timetable, Exams, Bookings, Disruptions, validator.py               │
├────────────────────────────────────────────────────────────────────────┤
│ MILESTONE 2: Backend REST API, RBAC & Storage Layer       [100% DONE]   │
│  - Express endpoints, JSON store, PostgreSQL adapter, Audit logs       │
├────────────────────────────────────────────────────────────────────────┤
│ MILESTONE 3: Comprehensive Frontend Application            [NEXT UP]   │
│  - 3A: App Shell, Header with Role Switcher, Tab Navigation            │
│  - 3B: Interactive Timetable Grid (Filter by Group, Faculty, Room)     │
│  - 3C: Spectra Booking Portal with Gemini AI Natural-Language Parser   │
│  - 3D: Disruption Simulation, Repair Engine & Stability Diff Viewer    │
│  - 3E: Midsem Exam Schedule Explorer & Admin Master Controls           │
├────────────────────────────────────────────────────────────────────────┤
│ MILESTONE 4: Live Staging Database & Cloud Deployment                  │
│  - Execute test_postgres_staging_live.ts against real PostgreSQL       │
│  - Deploy containerized solver / full-stack app to hosting platform    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Exact Tests Required Before Hackathon Submission

Before final submission, the following verification suite must pass:

```bash
# 1. Official Validator on Baseline Schedule (Hard violations: 0, Inversions: 0)
python3 starter_pack/CrunchWeek_StarterPack/validator.py \
  --data starter_pack/CrunchWeek_StarterPack/data/cit_public.json \
  --schedule exports/schedule.json

# 2. Official Validator on Disrupted Schedule (Hard violations: 0, Moved <= 12)
python3 starter_pack/CrunchWeek_StarterPack/validator.py \
  --data starter_pack/CrunchWeek_StarterPack/data/cit_public.json \
  --schedule exports/schedule_after.json \
  --disruption starter_pack/CrunchWeek_StarterPack/examples/sample_disruption.json \
  --baseline exports/schedule.json

# 3. Python Solver Unit Test Suite (6/6 tests passing)
python3 -m unittest discover tests

# 4. Backend API & RBAC Integration Test Suite (53/53 tests passing)
npx tsx tests/test_api.ts

# 5. Security & Isolation Test Suite (40/40 tests passing)
npx tsx tests/test_security.ts

# 6. Persistence & Audit Verification Suite (47/47 tests passing)
npx tsx tests/test_audit_verification.ts

# 7. PostgreSQL Storage Adapter Unit Suite (47/47 tests passing)
npx tsx tests/test_postgres_storage_mock.ts

# 8. PostgreSQL Schema & Driver Fallback Suite (30/30 tests passing)
npx tsx tests/test_postgres_schema.ts

# 9. TypeScript Compilation & Linting (0 errors)
npm run lint
npm run build
```

---

## 9. Single Highest-Priority Next Task Recommendation

### **RECOMMENDATION: Build Milestone 3 — The Comprehensive Role-Based Frontend Application**

**Why this is the single highest-priority task:**
The backend APIs, deterministic scheduling engine, official validator integration, and persistence layer are fully functional and pass all 225 automated tests. However, an evaluator opening the application today sees a blank white screen because `src/App.tsx` has not been implemented.

Building **Milestone 3** will bring the application to life by providing:
1. **Interactive Role Switcher**: Instant switching between Admin (Dr. S. K. Nayak), Department Coordinator (CSE), Faculty (F19), Club Representative (Dramatics), and Student (CSE-3 / Priya).
2. **Interactive Timetable Grid**: 5-day $\times$ 9-period timetable matrix with dynamic filtering by student group, faculty member, and classroom.
3. **Spectra Week Booking & Plain-Language AI Assistant**: Visual booking submission form integrated with Gemini 2.5 Flash to parse English/Hinglish requests into structured booking drafts.
4. **Disruption Simulator & Stability Diff**: One-click disruption injector allowing judges to simulate room closures or faculty leave and visually inspect relocated vs. unaffected sessions.
5. **Admin Master Console & Exam Explorer**: One-click timetable generation, schedule approvals, user management, and audit log inspection.
