// tools/car-editor/git.js
//
// Thin wrappers around the exact git commands the car editor's PR flow uses
// (added in Task 7), plus the pure helpers below — branch naming and URL
// building — which are cheap to unit test without touching git at all.

export function timestampBranchName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `car-editor-${stamp}`;
}

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
