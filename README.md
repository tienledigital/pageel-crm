<div align="center">
  <a href="https://pageel.com">
    <img src="https://raw.githubusercontent.com/pageel/pageel-cms/main/.github/assets/pageel-icon.svg" width="120" alt="Pageel CRM">
  </a>

  <h1>Pageel CRM</h1>

  <p><strong>A minimalist, lightning-fast CRM & automated bookkeeping system built on Astro, SQLite, and Cloudflare D1</strong></p>
  <p>Self-hosted financial and invoicing engine tailored for Vietnamese small businesses.</p>

  [![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Version](https://img.shields.io/badge/Version-v0.1.0-blue.svg)](CHANGELOG.md)
  ![Status](https://img.shields.io/badge/Status-Beta-orange.svg)
  [![Built with Astro](https://img.shields.io/badge/Built%20with-Astro-BC52EE.svg?logo=astro&logoColor=white)](https://astro.build)

  <br />

  <a href="README.md">🇺🇸 <b>English</b></a> | <a href="docs/locales/vi-VN.md">🇻🇳 <b>Tiếng Việt</b></a>
</div>

<br/>

## Table of Contents
- [Overview](#overview)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Database Architecture](#database-architecture)
- [License](#license)

---

## 🎯 Overview

**Pageel CRM** is a self-hosted, lightweight CRM and automated invoicing engine designed for small businesses and households (HKD) in Vietnam. It operates directly on edge nodes using Cloudflare Pages, eliminating server maintenance overhead while ensuring zero-cold-start performance.

---

## ✨ Key Features

- **Automated Bookkeeping:** Seamless bank transaction matching and reconciliation via SePay Webhook integrations.
- **Dynamic Database Routing:** Automatically uses an in-memory SQLite database for testing, local SQLite database for development, and Cloudflare D1 for production deployment.
- **Financial Compliance:** Auto-generates quarterly and monthly tax report spreadsheets complying with standard Vietnamese bookkeeping guidelines (S1a-HKD).
- **TDD-First Architecture:** Decoupled codebase utilizing Repository patterns, tested locally with Vitest.

---

## 💻 Tech Stack

- **Framework:** [Astro](https://astro.build/) (Serverless endpoints and static front-end)
- **Database ORM:** [Drizzle ORM](https://orm.drizzle.team/)
- **Database Engine:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (Production) & SQLite / [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) (Local/Testing)
- **Testing Suite:** [Vitest](https://vitest.dev/)

---

## 🚀 Quick Start

### Prerequisites
- Node.js (v18 or higher)
- npm (v9 or higher)

### Setup & Run
1. Clone the repository:
   ```bash
   git clone https://github.com/pageel/pageel-crm.git
   cd pageel-crm
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Initialize the local database schema:
   - For Cloudflare local emulator development (recommended):
     ```bash
     npx wrangler d1 migrations apply DB --local
     ```
   - For standalone Astro dev server (using SQLite local.db fallback):
     ```bash
     npx drizzle-kit push
     ```
4. Run the development server:
   - For Cloudflare emulated environment (D1 & KV bindings active):
     ```bash
     npm run dev:cf
     ```
   - For standalone Astro dev server:
     ```bash
     npm run dev
     ```
5. Run the unit test suite:
   ```bash
   npx vitest run
   ```

---

## 📐 Database Architecture

The application decouples business logic from physical storage engines using a dynamic database router:

- **Local & Unit Tests:** Operates using a fast, isolated in-memory SQLite database.
- **Production Edge:** Leverages Cloudflare D1's distributed SQLite engine via `platform.env.DB`.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
