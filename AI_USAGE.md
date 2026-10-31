# AI Usage Disclosure
**CIT Campus Scheduling and Venue Management**

## 1. Generative AI Tools & Models
- **Model:** Google Gemini 2.5 Flash
- **SDK:** `@google/genai` (v2.4.0)

## 2. Scope of Generative AI Integration
- **Natural Language Venue Request Parsing:** Translating English and Hinglish plain-language messages (e.g., *"seminar hall kal shaam 6 baje, 2 ghante, 100 log, mic chahiye"*) into structured booking draft objects (`attendance`, `duration_periods`, `windows`, `needs`, `room_types`).
- **Conversational Clarification:** Prompting users for missing parameters when natural-language requests are underspecified or ambiguous (e.g., missing attendance count or requested time).
- **Human-Readable Explanations:** Explaining deterministic validation error reports in scannable, natural language for faculty and students.

## 3. Strict Boundary: Non-AI Deterministic Core
- **No LLM Scheduling Decisions:** An LLM is never permitted to assign periods, assign rooms, approve/reject bookings, or evaluate schedule validity.
- **Deterministic Constraint Engine:** All 189 teaching sessions, 41 midsem exams, 25 Spectra week bookings, and disruption repairs are computed strictly by deterministic constraint satisfaction algorithms (`engine/timetable_solver.py`, `engine/exam_scheduler.py`, `engine/booking_allocator.py`, `engine/disruption_repair.py`).
- **Independent Validation:** Schedule validity is governed solely by deterministic application rules verified directly against the official starter pack validator (`validator.py`).
