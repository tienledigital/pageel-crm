import { customers, invoices, payments } from '../db/schema';

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
export async function exportDatabaseToJson(db: any): Promise<string> {
  const allCustomers = await db.select().from(customers);
  const allInvoices = await db.select().from(invoices);
  const allPayments = await db.select().from(payments);

  return JSON.stringify({
    customers: allCustomers,
    invoices: allInvoices,
    payments: allPayments,
  });
}

/**
 * Push file content directly to GitHub repo using Git Database low-level API.
 * Uses a 5-step process: GET ref, POST blob, POST tree, POST commit, PATCH ref.
 */
export async function pushBackupToGit(params: BackupParams): Promise<string> {
  const { token, owner, repo, branch, filePath, content, commitMessage } = params;
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
    throw new Error(`GitHub API error GET ref: ${refRes.status} ${refRes.statusText}`);
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
    throw new Error(`GitHub API error POST blob: ${blobRes.status} ${blobRes.statusText}`);
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
    throw new Error(`GitHub API error POST tree: ${treeRes.status} ${treeRes.statusText}`);
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
    throw new Error(`GitHub API error POST commit: ${commitRes.status} ${commitRes.statusText}`);
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
    throw new Error(`GitHub API error PATCH ref: ${updateRefRes.status} ${updateRefRes.statusText}`);
  }
  const updateRefData = await updateRefRes.json() as any;
  
  return updateRefData.object.sha;
}
