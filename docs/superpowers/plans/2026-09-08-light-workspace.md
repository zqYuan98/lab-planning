# Light Workspace Implementation Plan

**Goal:** Implement the user's supplied light dashboard design and logo across the existing application.

**Architecture:** Keep business APIs and SQLite unchanged. Add typed navigation intents for real quick actions and search; derive overview metrics and calendar from accessible bootstrap data. Split shell, overview, and shared/page styling ownership for parallel work.

**Tech Stack:** React, TypeScript, existing Lucide icons and CSS, Node test runner.

- [x] Review supplied design against existing page APIs and accessible data.
- [x] Implement App shell, grouped sidebar, uploaded brand assets, top search and action, preserving dirty navigation protection.
- [x] Implement overview metrics, real month weeks, monthly/weekly chain, reminders and shortcuts.
- [x] Apply global light tokens to all pages and connect navigation intents to forms, filters and details.
- [x] Validate meaningful calendar/metric edge cases, build and existing tests; review role access and keyboard behavior.
- [x] Verify empty and populated states in desktop/mobile browser using isolated data, then update local production assets.
- [x] Review tracked files and publish reviewed source to the existing private repository.
