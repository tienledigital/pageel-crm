// @para-doc [operations-guide.md#5-huong-dan-khoi-phuc-du-lieu-database-disaster-recovery]
import { users, staff, customers, invoices, payments, config } from '../db/schema';

// @para-doc [operations-guide.md#5-huong-dan-khoi-phuc-du-lieu-database-disaster-recovery]
export interface BackupParams {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
  content: string;
  commitMessage: string;
}

/**
 * Export all relevant tables to a minified JSON string.
 */
// @para-doc [infrastructure.md#3-kien-truc-sao-luu-du-lieu-qua-github-api-github-backup-pipeline]
export async function exportDatabaseToJson(db: any): Promise<string> {
  const allUsers = await db.select().from(users);
  const allStaff = await db.select().from(staff);
  const allCustomers = await db.select().from(customers);
  const allInvoices = await db.select().from(invoices);
  const allPayments = await db.select().from(payments);
  const allConfig = await db.select().from(config);

  return JSON.stringify({
    users: allUsers,
    staff: allStaff,
    customers: allCustomers,
    invoices: allInvoices,
    payments: allPayments,
    config: allConfig,
  });
}

/**
 * Push file content directly to GitHub repo using Git Database low-level API.
 * Uses a 5-step process: GET ref, POST blob, POST tree, POST commit, PATCH ref.
 */
// @para-doc [infrastructure.md#3-kien-truc-sao-luu-du-lieu-qua-github-api-github-backup-pipeline]
export async function pushBackupToGit(params: BackupParams): Promise<string> {
  const { token, owner, repo, branch, filePath, content, commitMessage } = params;

  // Basic input validation
  const ownerRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
  const repoRegex = /^[a-zA-Z0-9-_.]+$/;
  const branchRegex = /^[a-zA-Z0-9-_./]+$/;

  if (!owner || !ownerRegex.test(owner)) {
    throw new Error(`Invalid GitHub owner: "${owner}"`);
  }
  if (!repo || !repoRegex.test(repo)) {
    throw new Error(`Invalid GitHub repository name: "${repo}"`);
  }
  if (!branch || !branchRegex.test(branch)) {
    throw new Error(`Invalid GitHub branch name: "${branch}"`);
  }
  if (!token || token.trim() === '') {
    throw new Error('GitHub Backup Token is required and cannot be empty.');
  }

  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pageel-crm-backup-client',
    'Content-Type': 'application/json',
  };

  // Step 1: Get the parent commit SHA (reference of the branch)
  const refUrl = `${baseUrl}/git/ref/heads/${branch}`;
  const refRes = await fetch(refUrl, { headers });
  if (!refRes.ok) {
    let errorDetail = '';
    try {
      const errJson = await refRes.json() as any;
      if (errJson && errJson.message) {
        errorDetail = `: ${errJson.message}`;
      }
    } catch {}
    throw new Error(`GitHub API error GET ref: ${refRes.status} ${refRes.statusText}${errorDetail}`);
  }
  const refData = await refRes.json() as any;
  const parentSha = refData.object.sha;

  // Step 2: Create a blob for the file content
  const blobUrl = `${baseUrl}/git/blobs`;
  const blobRes = await fetch(blobUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      content,
      encoding: 'utf-8',
    }),
  });
  if (!blobRes.ok) {
    let errorDetail = '';
    try {
      const errJson = await blobRes.json() as any;
      if (errJson && errJson.message) {
        errorDetail = `: ${errJson.message}`;
      }
    } catch {}
    throw new Error(`GitHub API error POST blob: ${blobRes.status} ${blobRes.statusText}${errorDetail}`);
  }
  const blobData = await blobRes.json() as any;
  const blobSha = blobData.sha;

  // Step 3: Create a tree referencing the new blob
  const treeUrl = `${baseUrl}/git/trees`;
  const treeRes = await fetch(treeUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_tree: parentSha,
      tree: [
        {
          path: filePath,
          mode: '100644',
          type: 'blob',
          sha: blobSha,
        },
      ],
    }),
  });
  if (!treeRes.ok) {
    let errorDetail = '';
    try {
      const errJson = await treeRes.json() as any;
      if (errJson && errJson.message) {
        errorDetail = `: ${errJson.message}`;
      }
    } catch {}
    throw new Error(`GitHub API error POST tree: ${treeRes.status} ${treeRes.statusText}${errorDetail}`);
  }
  const treeData = await treeRes.json() as any;
  const treeSha = treeData.sha;

  // Step 4: Create a commit pointing to the new tree
  const commitUrl = `${baseUrl}/git/commits`;
  const commitRes = await fetch(commitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: commitMessage,
      tree: treeSha,
      parents: [parentSha],
    }),
  });
  if (!commitRes.ok) {
    let errorDetail = '';
    try {
      const errJson = await commitRes.json() as any;
      if (errJson && errJson.message) {
        errorDetail = `: ${errJson.message}`;
      }
    } catch {}
    throw new Error(`GitHub API error POST commit: ${commitRes.status} ${commitRes.statusText}${errorDetail}`);
  }
  const commitData = await commitRes.json() as any;
  const newCommitSha = commitData.sha;

  // Step 5: Update reference of the branch to the new commit
  const updateRefUrl = `${baseUrl}/git/refs/heads/${branch}`;
  const updateRefRes = await fetch(updateRefUrl, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      sha: newCommitSha,
      force: false,
    }),
  });
  if (!updateRefRes.ok) {
    let errorDetail = '';
    try {
      const errJson = await updateRefRes.json() as any;
      if (errJson && errJson.message) {
        errorDetail = `: ${errJson.message}`;
      }
    } catch {}
    throw new Error(`GitHub API error PATCH ref: ${updateRefRes.status} ${updateRefRes.statusText}${errorDetail}`);
  }
  const updateRefData = await updateRefRes.json() as any;
  
  return updateRefData.object.sha;
}

/**
 * Fetch backup files list from GitHub repository.
 * Returns array of files in the backups/ folder.
 */
// @para-doc [infrastructure.md#3-kien-truc-sao-luu-du-lieu-qua-github-api-github-backup-pipeline]
export async function listBackupsFromGit(params: {
  token: string;
  owner: string;
  repo: string;
}): Promise<any[]> {
  const { token, owner, repo } = params;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/backups`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pageel-crm-backup-client',
  };

  const res = await fetch(url, { headers });
  if (res.status === 404) {
    // Backups directory doesn't exist yet, return empty list
    return [];
  }
  if (!res.ok) {
    throw new Error(`GitHub API error list backups: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return [];
  }
  // Filter for JSON files
  return data
    .filter((f: any) => f.name.endsWith('.json') && f.type === 'file')
    .map((f: any) => ({
      name: f.name,
      path: f.path,
      sha: f.sha,
      size: f.size,
      downloadUrl: f.download_url
    }))
    .reverse(); // Newest first
}

/**
 * Fetch a specific backup file's content from GitHub.
 */
// @para-doc [operations-guide.md#5-huong-dan-khoi-phuc-du-lieu-database-disaster-recovery]
export async function fetchBackupContent(params: {
  token: string;
  downloadUrl: string;
}): Promise<string> {
  const { token, downloadUrl } = params;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'pageel-crm-backup-client',
  };

  const res = await fetch(downloadUrl, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API error downloading backup: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
