# Shared Types — Plan

> Related plans: `../frontend/plan.md`, `../backend/plan.md`

## Tasks

- [x] Define WebSocket message types (UI ↔ Server protocol)
- [ ] Define ACP-related types used by both sides
- [ ] Define workspace, session, tab types

## Notes

- This is a plain TypeScript package with no runtime dependencies
- Imported by both frontend and backend
- Uses TypeScript type exports only (no runtime code for now)
