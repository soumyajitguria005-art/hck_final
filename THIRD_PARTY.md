# Third-Party Dependencies and Licenses
**CIT Campus Scheduling and Venue Management**

The following third-party software components and libraries are utilized in this project:

## 1. Backend Runtime & Libraries (Node.js / TypeScript)

| Package | Version | License | Purpose |
| :--- | :--- | :--- | :--- |
| **express** | `^4.21.2` | MIT | Backend HTTP server framework, routing, and REST API |
| **tsx** | `^4.21.0` | MIT | TypeScript execution engine for Node.js |
| **typescript** | `^7.0.2` | Apache-2.0 | Static typing and language toolchain |
| **dotenv** | `^17.2.3` | BSD-2-Clause | Environment variable management |
| **@google/genai** | `^2.4.0` | Apache-2.0 | Official Gemini API SDK for natural-language parsing |

## 2. Frontend Libraries (React 19 / Vite)

| Package | Version | License | Purpose |
| :--- | :--- | :--- | :--- |
| **react** | `^19.0.1` | MIT | UI component library |
| **react-dom** | `^19.0.1` | MIT | DOM rendering layer for React |
| **vite** | `^8.3.0` | MIT | Frontend build tool and development server |
| **@vitejs/plugin-react** | `^6.1.1` | MIT | Vite plugin for React JSX compilation |
| **tailwindcss** | `^4.3.3` | MIT | Utility-first CSS styling framework |
| **@tailwindcss/vite** | `^4.3.3` | MIT | Tailwind CSS integration for Vite |
| **lucide-react** | `^0.546.0` | ISC | UI icon assets |
| **motion** | `^12.23.24` | MIT | Motion and transition animation primitives |

## 3. Python Scheduling Core (Standard Library)

| Component | Version | License | Purpose |
| :--- | :--- | :--- | :--- |
| **Python Standard Library** | `3.10.12` | Python Software Foundation (PSF) | Deterministic CSP engine, exam bin-packing, booking allocation, and disruption repair |
| **Crunch Week Validator** | `v1` | Official Hackathon Starter Pack | Official authoritative schedule validation script (`validator.py`) |

*Note: The scheduling engine relies strictly on the Python 3 standard library with zero external pip dependencies.*
