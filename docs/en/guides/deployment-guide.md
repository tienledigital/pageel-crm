# Production Deployment Guide

> **Project:** pageel-crm
> **File:** docs/guides/deployment-guide.md
> **Infrastructure:** Cloudflare Workers & Cloudflare D1

---

## 📋 1. Prerequisites
Before deploying to production, ensure you have:
1. An active [Cloudflare](https://dash.cloudflare.com/) account.
2. [Node.js](https://nodejs.org/) v22+ installed locally.
3. Authenticated your local environment with Wrangler CLI by running:
   ```bash
   npx wrangler login
   ```

---

## 🗄️ 2. Cloudflare Resource Configuration

### Step 1: Create a D1 Database
Run the following command in the `repo` directory to create a D1 database:
```bash
npx wrangler d1 create pageel-crm-db
```
This command returns configuration details including your `database_id`.

### Step 2: Create a KV Namespace for Sessions
Create a KV Namespace to persist active sessions:
```bash
npx wrangler kv namespace create SESSION
```
This command returns configuration details including the KV `id`.

### Step 3: Update wrangler.jsonc (For Local/Private deployment)
Open `repo/wrangler.jsonc` and replace the placeholder IDs with your actual database and KV namespace IDs:
```json
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "pageel-crm-db",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "SESSION",
      "id": "YOUR_KV_NAMESPACE_ID"
    }
  ]
```

### Step 4: Apply Database Migrations to Remote D1
Apply the database schema from the `drizzle` directory to the live Cloudflare D1 instance:
```bash
npx wrangler d1 migrations apply pageel-crm-db --remote
```
*Note:* Press `y` when prompted to confirm the migrations.

---

## 🔒 3. OSS Security & Upstream-Origin Git Workflow

Since `pageel-crm` is an open-source project that you also run for private business, follow these security practices to protect credentials and resources:

### Configuration Commits:
- **Public OSS Repo:** Keep the `wrangler.jsonc` file with placeholders (`00000000-0000-0000-0000-000000000000`) so that other contributors can safely run the project and CI/CD pipelines pass successfully. Never commit real production IDs to the public repo.
- **Sensitive data:** Add custom data scripts and sensitive backups to `.gitignore`.

### Upstream-Origin Workflow (Recommended):
Establish a dual-remote repository setup:
1. Name the public OSS repo remote `upstream` and your private deployment repo remote `origin`.
2. Commit your production `wrangler.jsonc` (with real IDs) directly to your private repo (`origin`).
3. Pull new OSS updates from `upstream` and sync them to your deployment:
   ```bash
   git checkout main
   git pull upstream main
   git push origin main
   ```

---

## ⚙️ 4. Environment Variables & Secrets Configuration

All sensitive keys (secrets) must be encrypted directly on Cloudflare's infrastructure. **Do not store them in the source code**.

### Step 1: Initialize Secrets on Cloudflare
Run these commands in the `repo/` directory:

1. **SESSION_SECRET** (Used to sign session cookies. Must be a secure random 32-character hex string):
   *You can generate a random key using:*
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   *Then store it on Cloudflare:*
   ```bash
   npx wrangler secret put SESSION_SECRET
   ```

2. **Initial Admin User:**
   ```bash
   # The username of the initial admin (Defaults to 'admin' if omitted)
   npx wrangler secret put INITIAL_ADMIN_USERNAME
   
   # The password of the initial admin (Defaults to 'admin123' if omitted)
   npx wrangler secret put INITIAL_ADMIN_PASSWORD
   ```

3. **GitHub Backup Secrets:**
   Configure connection credentials to automatically push backup data to a private GitHub repository:
   ```bash
   npx wrangler secret put GITHUB_BACKUP_TOKEN
   npx wrangler secret put GITHUB_BACKUP_OWNER
   npx wrangler secret put GITHUB_BACKUP_REPO
   npx wrangler secret put GITHUB_BACKUP_BRANCH
   ```

> [!NOTE]
> **For Cloudflare Pages:** If you deploy as a Cloudflare Pages project and configure a different project name than the default `name` in `wrangler.jsonc` (e.g. `reddcom-crm`), you must use the `pages secret put` command with the `--project-name` flag:
> `npx wrangler pages secret put SESSION_SECRET --project-name <pages-project-name>`

### ⚠️ Important: Auto-Seed Behavior & Login Troubleshooting
- **How it works:** The system will auto-seed the admin user using the above secrets **only if the `users` database table is completely empty** (e.g., immediately after first deployment).
- **The Login Trap:** 
  - If you visit the login page *before* setting the Cloudflare secrets, the system will auto-seed the default username/password (`admin` / `admin123`).
  - Once created, setting new Secrets *will not* take effect because the table is no longer empty.
- **How to resolve:**
  Clear the `users` table using wrangler CLI to trigger the auto-seed again:
  ```bash
  npx wrangler d1 execute pageel-crm-db --remote --command "DELETE FROM users"
  ```
  Then reload your browser login page and sign in using your custom credentials.

> [!IMPORTANT]
> Once you successfully log in for the first time and the admin account is saved to the D1 database, you should delete the `INITIAL_ADMIN_*` secrets on the Cloudflare dashboard (or using `npx wrangler secret delete [SECRET_NAME]`) for safety. The login portal will only query the database from then on.

---

## 🚀 5. Deploying the Application

With all configurations and secrets ready, build and deploy the app to Cloudflare Workers:

### Step 1: Build the app locally
```bash
npm run build
```

### Step 2: Deploy to Cloudflare
```bash
npx wrangler deploy
```
Wrangler will compile and upload the Astro server-side assets and static files to edge CDN, returning your live site URL (e.g., `https://pageel-crm.your-subdomain.workers.dev`).
