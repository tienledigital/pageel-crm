# Setup & Development Guide

<!-- ⚠️ SOURCE-VERIFIED — Verified against package.json, wrangler.jsonc, and src/lib/db.ts on 2026-05-28 -->

> **Project:** pageel-crm
> **File:** docs/en/guides/development-guide.md
> **Version:** v0.8.1
> **Updated:** 2026-05-28

---

## 🚀 1. Environment Setup & Installation

To run this project locally, ensure you have **Node.js (version 22 or higher)** installed on your machine.

### Step 1: Install Dependencies
1. Navigate into the repository directory:
   ```bash
   cd repo
   ```
2. Install the package dependencies:
   ```bash
   npm install
   ```

### Step 2: Set Up Local D1 Database & Run Migrations
This project simulates **Cloudflare D1** in local development. You need to synchronize the schema structures before running the development server:
1. Apply the Drizzle migrations to the local D1 simulator (Miniflare):
   ```bash
   npx wrangler d1 migrations apply pageel-crm-db --local
   ```
   *Note:* Type `y` and press Enter when Wrangler requests confirmation.

### Step 3: Run the Development Server
*   Start the local development server with the mocked D1 binding:
     ```bash
     npm run dev
     ```
*   Access the application locally at: [http://localhost:4321](http://localhost:4321)

### Step 4: First-time Login (Auto-Seed)
When you access the login page for the first time on your local machine, the **Auto-Seed** system automatically creates a default administrator account if the `users` table is empty:
*   **Username:** `admin`
*   **Password:** `admin123`
*   **Role:** `admin`

### Step 5: Configure SePay API Token (Local Sync)
To test the active synchronization feature from SePay on your local development machine, create a `.dev.vars` file in the `repo/` folder and define your API Token:
```env
SEPAY_API_TOKEN=your_sepay_api_token_here
```
*(Note: The `.dev.vars` file contains private environment variables for local development and is ignored by Git in `.gitignore` to prevent secret leaks).*

---

## 🧪 2. Running Tests (Unit Tests)

We use **Vitest** as our primary testing framework and **Better-SQLite3** to run an incredibly fast in-memory SQLite database for local tests.

- Run the entire test suite once (One-shot mode):
  ```bash
  npx vitest run
  ```
- Run tests in watch mode:
  ```bash
  npx vitest
  ```

### 2.2. Manual Backup Test

To verify your GitHub API integration and backup engine from your local environment without booting the entire Astro server, you can run the manual backup script:

1. Ensure your backup repository and GitHub token variables are configured correctly in the `.dev.vars` file.
2. Run the script using Node:
   ```bash
   npx tsx scripts/test-backup-manual.ts
   ```

This script will load environment variables from `.dev.vars` (via the helper function `loadDevVars`), instantiate a mock JSON payload, and attempt to push it to the configured GitHub backup repository.

---

## 📐 3. Database Architecture & Routing

The database layer is built using **Drizzle ORM** and routed dynamically via the **DB Client Router**:

1.  **Testing Environment (`process.env.NODE_ENV === 'test'`):**
    - The Router automatically redirects queries to an **in-memory SQLite** instance (using `better-sqlite3`).
    - Data is fully isolated, cleared after each test file execution, and produces no physical database garbage files.
2.  **Production Environment (Cloudflare Workers):**
    - Astro v6 removes `Astro.locals.runtime.env`. The Router connects directly to the **Cloudflare D1** database by importing `env` from `cloudflare:workers` and passing it to the database initiator: `getDb(env)`.
3.  **Local Development Fallback:**
    - If there is no active D1 database binding and the process is not in test mode, the router creates a local physical SQLite database file named `local.db` in the repo root for development.

---

## 📝 4. Contribution & Development Guidelines

- **English-First for Source Code:** All variable names, function names, classes, inline code comments, and **Git commit messages** MUST be written in English to ensure global open-source collaboration capability.
- **Vietnamese for Local Documentation:** Internal guide docs and specs under the `docs/` folder are written in Vietnamese to optimize readability for the main core development team.
- **TDD (Test-Driven Development):** Always write a failing test case (RED) before implementing code changes for features or bug fixes.
- **Quality Gates:** Before committing code or opening a PR, ensure these checks pass:
  - TypeScript compiles successfully: `npm run build`
  - Unit test suite is 100% green: `npx vitest run`
