# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] - 2026-05-21

### Fixed
- Fixed database D1 connection crash in backup API (`/api/backup`) by passing the `env` binding explicitly and removing Node native `crypto` import for Cloudflare Workers compatibility.
- Fixed administrator user login crash caused by Astro v6 removal of `Astro.locals.runtime.env` (migrated to `cloudflare:workers` `env` binding).

### Changed
- Refactored entire deployment, development, and API contract documentation to target Cloudflare Workers, resolving obsolete Pages instructions.
- Standardized all public documentation examples to use `pageel-crm` as the mock worker name.

## [0.4.0] - 2026-05-21

### Added
- Excel S1a-HKD generation engine using `exceljs` supporting monthly sheet, quarterly ZIP, and yearly ZIP exports.
- Astro API endpoint `/api/export/s1a` with role-based authentication gate (admin/accountant).
- GitHub REST API Backup engine using raw REST API blobs, trees, and commits.
- Astro API endpoint `/api/backup` with role-based authentication gate (admin).
- Dashboard UI controls including Excel export forms, manual backup button, and recent backup logs table.
- Full E2E integration test suite covering SePay webhook -> Excel export -> GitHub backup mock -> DB logging.

## [0.1.0] - 2026-05-20

### Added

- Initialize Astro project structure.
- Dynamic DB Router for in-memory SQLite (testing) and Cloudflare D1 (production).
- Bookkeeping database schemas (customers, invoices, payments, settings, sync_logs).
- Repository pattern interfaces and Vitest unit testing.
- OSS standard README in English and Vietnamese translation.
