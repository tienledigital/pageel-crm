---
title: "changelog"
order: 1
---
# Changelog

All notable changes to this project will be documented in this file.

## [0.12.0] - 2026-07-13

### Added
- **Pending Orders & Cycle Multipliers**: Added support for quick draft orders (unpaid) and custom billing cycle months multipliers. Payment descriptions automatically accept period suffixes (e.g. `X{N}` where `{N}` is the cycle count) which are auto-parsed by the webhook reconciliation engine (supporting 1-60 months).
- **Partial Wallet Deduction**: Implemented automated partial wallet deductions and FIFO top-ups for customer balance reconciliations, updating order status to `partially_paid` with virtual wallet payments.
- **Unified Reconcile Modal**: Merged Late Association (quick order creation) form directly into the manual reconciliation modal with client-side order amount mismatch warnings.
- **Dynamic Reports Module**: Integrated dynamic month-to-month range filters (`startMonth` and `endMonth`) into API preview `/api/crm/reports/preview` and Excel export `/api/export/s1a`.
- **Merged Excel Export**: Added a single file merged export option (`singleFile=true`) to consolidate multiple months of tax revenue data into one Excel sheet.
- **Reports Dashboard UI**: Redesigned the `/crm/reports` interface with 3 direct action buttons (Merged Excel, ZIP Month Range, ZIP 12 Months) for improved user experience.
- **Code-Docs Double-Binding Traceability**: Injected `@para-doc` anchor comments into API source code (`config.ts`, `preview.ts`, `reconcile.ts`, `csrf.ts`) and synchronized Code-Graph linkages.
- **Updated Documentation**: Upgraded tax reporting specifications (`tax-reporting-spec.md`) and API contracts (`api-contracts.md`) to version 0.12.0, and generated Notion-themed static HTML files.

### Fixed
- **Astro Client-side Parser Error**: Patched string interpolation syntax in Astro `<script define:vars>` block to prevent compilation errors.
- **SQLite FK Deletion ordering**: Solved Drizzle SQLite Foreign Key constraint violations on payment unlinking by clearing references before deleting linked orders.

## [0.11.4] - 2026-06-09

### Added
- **DB Transactions Retry & Fallback**: Implemented an automated retry mechanism with exponential backoff for SQLite database lock contentions and sequential client fallback for D1 local emulation.
- **Schema Validation Guards**: Added structural integrity checks within database transaction flows.

## [0.11.2] - 2026-06-09

### Added
- **Direct Payment Reconciliation Engine**: Implemented Option 2 (Direct Payment + Deposit Remainder) reconciliation logic for SePay webhook matching. Direct payments are mapped to 'revenue' categories and set orders directly to `paid` status without charging the customer wallet balance.
- **Deposit Surplus Wallet Topup**: Overpaid payments automatically deposit only the surplus amount (payment amount minus order amount) to the customer wallet.
- **Manual Payment Link/Unlink API**: Refactored `/api/crm/payments/reconcile` to support manual gán/hủy gán with wallet refunds for deposit payments and no-refunds for direct payments.
- **Service Extension Engine**: Unified service period extension and expiration timestamp calculations under `extendCustomerService`.
- **Modularized User Guide**: Partitioned the legacy single `user-guide.md` file into 8 specialized modular documentation files (`01-dashboard.md` through `08-audit.md`) corresponding to the Sidebar navigation items of Pageel CRM.
- **Double-Binding Documentation Links**: Integrated reverse anchor comments (`// @para-doc [user-manual/xx-name.md]`) in the frontmatter of all 8 Astro page files and graph-node markers in markdown files to ensure full bidirectional traceability.
- **Settings Login Documentation**: Documented the system login procedure (`/login` path) as section 1 of the Settings & Auth manual (`07-settings.md`).

### Changed
- **Documentation index update**: Updated [README.md](file:///media/tienle/DATA/WORKSPACE/para/Projects/pageel-crm/docs/README.md) file index list and compiled Notion-themed static HTML files in `docs/.html`.

## [0.11.1] - 2026-06-08

### Added
- **UI Reconciliation Dashboard Page**: Created `/crm/settings/audit` page featuring statistical overview cards for orphaned orders and cross-linking discrepancies.
- **Reconciliation Check & Action APIs**: Implemented `/api/crm/audit/check` (GET) to query data discrepancies and `/api/crm/audit/action` (POST) to execute bulk/single data fixes.
- **Order Edit & Date Updates**: Displayed order issued date and last updated timestamp on UI tables and mobile views. Implemented automated `updatedAt` field updates during order edits.

## [0.11.0] - 2026-06-06

### Changed
- **Renamed Invoices to Orders (Schema Drop)**: Dropped legacy invoices table structurally from the schema and database migrations. Transitioned the billing engine to utilize the `orders` table directly.
- **Completed Order Management Layout**: Hardened order creation layout, customized the navigation icons, and fixed CSP headers for security compliance.

## [0.10.2] - 2026-06-05

### Added
- **Late Association Date Selection**: Added option to use the bank transaction date as the Start Date of the service package in Late Association modal, rather than forcing today's date.
- **Customer Main Service Auto-Assignment**: Implemented `autoAssignMainService` which automatically maps the customer's most recently assigned service package (from `customerServices` or `orders` history) to their main `serviceId` on customer page load if it was previously blank.

### Changed
- **Late Association Writes to Orders**: Refactored Late Association flow to create a service package order (mã `ORD-` in table `orders`) and link `payments.orderId` instead of creating an invoice. This satisfies the requirement of using Invoices solely for tax declaration while Orders handle active service cycles.

### Fixed
- **Content-Security-Policy (CSP) Image Loading**: Hardened Content-Security-Policy in middleware by adding `https://img.vietqr.io` to `img-src` directive, allowing browser to load dynamic VietQR code images correctly.
- **Null Customer ID for Anonymous Outgoing Payments**: Updated reconciliation logic to set `customerId = null` (instead of `'CUST-ANONYMOUS'`) for unmatched outgoing expenses, resolving SQL query crashes on null references.

## [0.10.0] - 2026-06-05

### Added
- **Automatic Orders and Manual Invoices Separation**: Split auto-generated orders (mã `ORD-` at `/crm/orders`) and manual invoices (mã `PO-` at `/crm/invoices` + taxInvoiceNumber).
- **Service Packages Integration**: Customers now support `serviceId` (gói dịch vụ chính) and `balance` (ví số dư đối soát). Added "Set Main Service" in QR Tool UI.
- **Reconciliation Wallet & Shared Wallet logic**: Implemented automatic wallet charging, wallet deduction, FIFO automated wallet scanning for pending/partial payments, and virtual `wallet_deduction` payment insertions.
- **Bilingual Service Name in Excel S1a**: Automatically join services table to get Vietnamese accented service package name for Excel column C (Diễn giải).
- **Centralized Role-based Authentication (Astro Middleware)**: Implemented Astro middleware for route checking. Saler only has access to QR Tool and customer update API, while Accountant is restricted from Settings.

## [0.9.1] - 2026-06-03

### Added
- **Dynamic SePay Sync Config**: Added advanced sync modal and split button on CRM payments dashboard.
- **Upfront SSR Optimization**: Excluded `exceljs` and `jszip` from Vite SSR optimization, resolving `require is not defined` and lazy pre-bundling crashes.

### Fixed
- **Cloudflare Workers Excel template error**: Inline template xlsx to base64 code (`excelTemplateBase64.ts`) and cached ArrayBuffer in RAM via Lazy Singleton, resolving "Failed to load template" on production.
- **Umask Polyfill**: Patched process.umask using `polyfillUmask.ts` loaded statically before ExcelJS initialization.

## [0.9.0] - 2026-06-01

### Added
- **Services & Late Association**: Added product/service catalog management, manual transaction association (Late Association) for unmatched payments.

## [0.8.1] - 2026-05-27

### Added
- **Customer Edit Feature**: Implemented customer profile updates API and modal dialog (supporting Name, Phone, Email, Address, Notes, Tax code, Assigned Staff, etc.) with automated testing.
- **Data Backup & Restore Panel**: Created a backup/restore component in Settings with manual restore triggers, dynamic tables, table cleanup capabilities, and log downloads.
- **Bilingual Payment Page**: Translated all payment classification rules, trigger forms, manual reconciliation modals, and bank settings cards.
- Integrated design system CSS and connected live database queries to dashboard.
- Implemented responsive grid customer management layout and search functionality.
- Implemented mobile responsive invoice list layout and status update actions.
- Implemented bank settings, payment deletion, bulk cleanup, custom classification rules, and integration tests.

### Changed
- **Renamed Invoices to Orders (Đơn hàng)**: Renamed references of "Invoices" to "Orders / Đơn hàng" across dashboard menus, sidebar layouts, lists, backup scripts, and SVG database schemas.
- **Settings Layout Tabs**: Refactored the settings page into modular horizontal tabs (General, SePay, Database, Security, Logs, Backup) and removed redundant sidebar links.
- Optimized login authentication, Excel report export, webhook matching, backup connection, and core tests.

### Fixed
- Fixed 500 Internal Server Error on production payments dashboard by applying missing database D1 migrations (`0002` and `0003`) containing the `category` column.
- Hardened payments dashboard SSR logic with try-catch blocks for configuration rules JSON parsing, safe date parsing, and lowercase checks on customer/invoice IDs.
- Updated payment classification skip guard and fixed SePay date parsing/formatting with Vietnam timezone.


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
