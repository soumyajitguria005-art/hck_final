# Production Deployment & Architecture Specification

## 1. System Overview

The CIT Campus Scheduling and Venue Management platform is designed for enterprise deployment across modern cloud infrastructure:

1. **Frontend & API Gateway (Vercel)**
   - Static React SPA bundle served at the edge with global CDN distribution.
   - Serverless / Node.js Express API runtime (`server/app.ts`) handling request authentication, role-based authorization, rate limiting, and business validation.
   - Configured via `vercel.json` with clean `/api/*` rewrites.

2. **Centralized Relational Database (PostgreSQL 14+)**
   - Managed PostgreSQL instance (Supabase, Neon, or Google Cloud SQL).
   - Authoritative relational schema defined in `server/db/schema.sql` (10 institutional departments, 27 rooms, 40 faculty, 14 student groups, 62 courses, 189 sessions, 41 exams).
   - Strong consistency: partial unique index `idx_single_approved_schedule` guarantees only one active approved master timetable.
   - Double-booking prevention via `idx_sched_sess_no_double_book` on `scheduled_sessions(schedule_version_id, day, start_period, room_id)`.
   - Database-level triggers preventing self-approval:
     - `trg_venue_booking_no_self_approval` on `venue_bookings`
     - `trg_schedule_version_no_self_approval` on `schedule_versions`
     - `trg_disruption_no_self_approval` on `disruptions`

3. **Deterministic Scheduling Engine Microservice (Containerized Python)**
   - Containerized Python 3.11 image (`Dockerfile.solver`) with PuLP and Coin-OR CBC solvers.
   - Deployed on autoscaling container runtimes (Cloud Run, Fly.io, AWS ECS, or Kubernetes).
   - In development/local environments, `PythonBridge` invokes the local Python runtime directly. In production containerized environments, requests can optionally route via HTTPS to the solver microservice.

---

## 2. Storage Drivers & Zero-Secret Architecture

The application abstracts storage access behind the canonical `IStorage` interface (`server/storageInterface.ts`):

- **Default Driver (`STORAGE_DRIVER=json`)**:
  Active by default. Operates on transactional, atomic file writes in `data/storage/` without requiring database credentials or network access.
- **PostgreSQL Driver (`STORAGE_DRIVER=postgres`)**:
  Activated when `DATABASE_URL` is set. Uses `PostgresStorage` with pooled connections, parameterized queries, and transactional safety.
- **Fail-Safe Fallback**:
  If `STORAGE_DRIVER=postgres` is requested but `DATABASE_URL` is not supplied, the factory function `createStorage()` logs a warning and safely falls back to JSON storage without application crashes or downtime.

---

## 3. Database Migration Runbook

To execute a migration or seed the managed PostgreSQL database:

```bash
# 1. Dry run verification (validates DDL and reports authoritative entity counts without writes)
npm run migrate -- --dry-run
# or
npx tsx server/db/migrate.ts --dry-run

# 2. Live migration (requires DATABASE_URL)
DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require" npx tsx server/db/migrate.ts
```

The migration runs inside a single database transaction (`BEGIN` / `COMMIT`). If any step or constraint fails, the entire transaction is rolled back (`ROLLBACK`) automatically.

---

## 4. Role-Based Access Control & Production Authentication

The system implements 5 strict roles:
1. `admin`: Global timetable generation, manual schedule approvals, system-wide booking decisions, and audit log inspection.
2. `department_coordinator`: Propose disruption scenarios, inspect department-specific courses and faculty.
3. `faculty`: View assigned timetable and calendar, submit booking requests.
4. `club`: Submit event booking requests with priority capping (`club_event`).
5. `student`: View assigned cohort timetable and private calendar.

In production mode (`NODE_ENV=production`):
- Demo headers (`x-user-id`) and query parameters (`?asUser=...`) are strictly blocked.
- Server verifies authentication tokens exclusively against persistent storage (`user_auth_tokens`).
- Self-approval is rejected at both API middleware and database trigger levels.
