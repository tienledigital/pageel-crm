#!/usr/bin/env bash
# @para-doc [plan-v0.10.0#phase-7-deploy-pipeline]
# Safe deployment script for pageel-crm
# Enforces: backup → review migrations → user confirm → apply → deploy
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}═══════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  pageel-crm Safe Deploy Pipeline${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════${NC}"

# Step 1: Fetch the real database ID dynamically from wrangler CLI
# This avoids hardcoding production secrets or UUIDs in the public repository.
echo -e "\n${GREEN}[1/5]${NC} Fetching database ID for pageel-crm-db..."
REAL_DB_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e '
  const fs = require("fs");
  try {
    const list = JSON.parse(fs.readFileSync(0, "utf-8"));
    const db = list.find(item => item.name === "pageel-crm-db");
    if (db && db.uuid) {
      console.log(db.uuid);
    } else {
      process.exit(1);
    }
  } catch (e) {
    process.exit(1);
  }
' || true)

if [ -z "$REAL_DB_ID" ]; then
  echo -e "  ${RED}Error: Could not find D1 database 'pageel-crm-db' on your Cloudflare account.${NC}"
  echo "  Please run 'npx wrangler login' and ensure the database exists."
  exit 1
fi
echo -e "  Found database UUID: ${GREEN}$REAL_DB_ID${NC}"

# Temporary wrangler config setup to inject real D1 database UUID
TEMP_CONFIG=$(mktemp wrangler-temp.XXXXXX.jsonc)
trap 'rm -f "$TEMP_CONFIG"' EXIT

sed "s/00000000-0000-0000-0000-000000000000/$REAL_DB_ID/g" wrangler.jsonc > "$TEMP_CONFIG"

# Step 2: Check for pending migration files
echo -e "\n${GREEN}[2/5]${NC} Checking for pending migrations..."
MIGRATION_DIR="./drizzle"
PENDING=$(find "$MIGRATION_DIR" -name "*.sql" -newer ".wrangler/state" 2>/dev/null | head -20 || true)

if [ -z "$PENDING" ]; then
  echo "  No new migration files detected."
else
  echo -e "  ${YELLOW}New migration files found:${NC}"
  echo "$PENDING" | sed 's/^/    /'
fi

# Step 3: Review migration SQL (show content)
echo -e "\n${GREEN}[3/5]${NC} Reviewing migration SQL files..."
for sql_file in "$MIGRATION_DIR"/*.sql; do
  if [ -f "$sql_file" ]; then
    echo -e "\n  ${YELLOW}── $(basename "$sql_file") ──${NC}"
    cat "$sql_file" | sed 's/^/    /'
    
    # Warn about destructive operations
    if grep -qiE "DROP|DELETE|ALTER.*DROP" "$sql_file"; then
      echo -e "  ${RED}⚠️  WARNING: Destructive operation detected!${NC}"
    fi
  fi
done

# Step 4: Backup production DB via D1 export
echo -e "\n${GREEN}[4/5]${NC} Backing up production database..."
BACKUP_FILE="backup-$(date +%Y%m%d-%H%M%S).sql"
echo "  Running: wrangler d1 export DB --remote --output $BACKUP_FILE -c $TEMP_CONFIG"
npx wrangler d1 export DB --remote --output "$BACKUP_FILE" -c "$TEMP_CONFIG" 2>&1 || {
  echo -e "  ${RED}Backup failed! Aborting deploy.${NC}"
  exit 1
}
echo -e "  ${GREEN}✅ Backup saved to $BACKUP_FILE${NC}"

# Step 5: User confirmation
echo -e "\n${YELLOW}═══════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Ready to apply migrations to PRODUCTION${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════${NC}"
read -p "Apply migrations to production D1? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo -e "${RED}Aborted by user.${NC}"
  exit 0
fi

# Step 6: Apply migrations
echo -e "\n${GREEN}[5/5]${NC} Applying migrations to production..."
npx wrangler d1 migrations apply DB --remote -c "$TEMP_CONFIG" 2>&1 || {
  echo -e "${RED}Migration failed! Use D1 Time Travel to restore:${NC}"
  echo "  wrangler d1 time-travel restore pageel-crm-db --timestamp $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 1
}

echo -e "\n${GREEN}✅ Migrations applied successfully!${NC}"
echo -e "\nNext step: Deploy code with 'npx wrangler pages deploy'"
