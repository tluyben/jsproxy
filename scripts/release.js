#!/usr/bin/env node
// Upload a built binary to a GitHub release matching package.json version.
// Usage: node scripts/release.js <platform>
// Platforms: linux-x86, linux-arm, macosx-arm
// Requires: GITHUB_TOKEN, GITHUB_REPO (e.g. "owner/repo") env vars

const fs = require('fs');
const path = require('path');

const platform = process.argv[2];
if (!platform) {
  console.error('Usage: node scripts/release.js <platform>');
  process.exit(1);
}

const { version, name } = require('../package.json');
const tag = `v${version}`;
const binaryName = `${name}-${platform}`;
const binaryPath = path.join(__dirname, '..', 'dist', binaryName);

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

const repo = process.env.GITHUB_REPO;
if (!repo) {
  console.error('GITHUB_REPO environment variable is required (e.g. owner/repo)');
  process.exit(1);
}

if (!fs.existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`);
  console.error(`Run "npm run build:${platform}" first`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'jsproxy-release-script'
};

async function getReleaseByTag (tag) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createRelease (tag) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      draft: false,
      prerelease: false
    })
  });
  if (!res.ok) throw new Error(`Failed to create release ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deleteExistingAsset (release, assetName) {
  const existing = release.assets.find(a => a.name === assetName);
  if (!existing) return;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${existing.id}`, {
    method: 'DELETE',
    headers
  });
  if (!res.ok) throw new Error(`Failed to delete existing asset ${res.status}: ${await res.text()}`);
  console.log(`Deleted existing asset: ${assetName}`);
}

async function uploadAsset (uploadUrl, assetName, filePath) {
  // Strip {?name,label} template from upload_url
  const url = uploadUrl.replace(/\{[^}]+\}/, '') + `?name=${encodeURIComponent(assetName)}`;
  const fileBuffer = fs.readFileSync(filePath);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileBuffer.length)
    },
    body: fileBuffer
  });
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main () {
  const assetName = binaryName;

  console.log(`Releasing ${assetName} for tag ${tag} to ${repo}`);

  let release = await getReleaseByTag(tag);
  if (release) {
    console.log(`Found existing release: ${release.html_url}`);
    await deleteExistingAsset(release, assetName);
  } else {
    console.log(`Creating release for tag ${tag}...`);
    release = await createRelease(tag);
    console.log(`Created release: ${release.html_url}`);
  }

  console.log(`Uploading ${binaryPath}...`);
  const asset = await uploadAsset(release.upload_url, assetName, binaryPath);
  console.log(`Uploaded: ${asset.browser_download_url}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
