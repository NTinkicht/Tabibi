#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/NTinkicht/Tabibi.git"
SECRET_NAME="TABIBI_GITHUB_PAT"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required in the Codex Cloud environment" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y -qq
    apt-get install -y -qq gh
  else
    echo "GitHub CLI (gh) is missing and no supported package manager is available" >&2
    exit 2
  fi
fi

if [[ -z "${TABIBI_GITHUB_PAT:-}" ]]; then
  echo "Missing Codex environment secret: ${SECRET_NAME}" >&2
  echo "Create a fine-grained GitHub PAT restricted to NTinkicht/Tabibi, then store it only as a Codex Cloud environment secret named ${SECRET_NAME}." >&2
  exit 3
fi

# Authenticate gh without exposing the token in process arguments or repository config.
printf '%s' "${TABIBI_GITHUB_PAT}" | gh auth login --hostname github.com --with-token >/dev/null
unset TABIBI_GITHUB_PAT

# Configure git to use the credential managed by gh.
gh auth setup-git >/dev/null

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "${REPO_URL}"
else
  git remote add origin "${REPO_URL}"
fi

# Preflight checks. These must succeed before an autonomous Codex task edits files.
gh auth status --hostname github.com
git ls-remote --exit-code origin HEAD >/dev/null

echo "Codex Cloud GitHub authentication preflight: PASS"
