// tools/car-editor/git.js
//
// Thin wrappers around the exact git commands the car editor's PR flow uses
// (added in Task 7), plus the pure helpers below — branch naming and URL
// building — which are cheap to unit test without touching git at all.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function timestampBranchName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `car-editor-${stamp}`;
}

// Only recognizes the SCP-like `git@host:owner/repo` SSH form, not the
// `ssh://git@host/owner/repo` form (falls through unchanged for the latter).
export function normalizeRemoteToHttps(remote) {
  const sshMatch = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  return remote.replace(/\.git$/, "");
}

export function compareUrl(httpsRemote, base, branch) {
  return `${httpsRemote}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}

export async function run(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export async function currentBranch(cwd) {
  return run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function dirtyTrackedFiles(cwd, files) {
  const out = await run(["status", "--porcelain", "--", ...files], cwd);
  return out.length > 0 ? out.split("\n") : [];
}

export async function createBranch(cwd, branchName) {
  await run(["checkout", "-b", branchName], cwd);
}

export async function commitFiles(cwd, files, message) {
  await run(["add", ...files], cwd);
  await run(["commit", "-m", message], cwd);
}

export async function pushBranch(cwd, branchName) {
  await run(["push", "-u", "origin", branchName], cwd);
}

export async function checkoutBranch(cwd, branchName) {
  await run(["checkout", branchName], cwd);
}

export async function deleteBranch(cwd, branchName) {
  await run(["branch", "-D", branchName], cwd);
}

export async function remoteUrl(cwd) {
  return run(["remote", "get-url", "origin"], cwd);
}
