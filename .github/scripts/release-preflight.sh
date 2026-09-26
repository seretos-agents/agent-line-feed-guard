#!/usr/bin/env bash
# release-preflight.sh <repo> <plugin> <version>
#
# Runs before any side-effecting release step. Reads the tag list on stdin
# (same contract as prev-release-tag.sh). In order:
#   1. Fail unless GITHUB_REF == refs/heads/$DEFAULT_BRANCH.
#   2. Validate <version> and resolve PREV_TAG via prev-release-tag.sh (the
#      strict semver grammar lives there only).
#   3. Fail if <TAG> (`<plugin>--v<version>`) already exists.
#   4. Fail if src/<TAG> already exists. Nothing is ever deleted.
#   5. If a PREV_TAG was resolved and src/<PREV_TAG> is missing, fail and
#      print the exact one-time bootstrap commands (see AGENTS.md). A first
#      release (no PREV_TAG) is allowed through.
#   6. On success, print `tag=`, `prev_tag=` and `main_sha=` (the script's
#      own `git rev-parse HEAD`) for the caller to append to $GITHUB_OUTPUT.
#
# Existence checks call `gh api repos/$REPO/git/ref/tags/<name>` (the
# singular `ref` endpoint matches exactly; the plural `refs` endpoint does
# prefix matching, e.g. it would match `...v0.0.1` against `...v0.0.10`).
# A genuine 404 means "absent". Any other `gh api` failure (auth, rate
# limit, 5xx) means the existence of that ref is UNKNOWN and must be a hard
# failure — it must never be read as "absent", or a transient error on the
# "does <TAG> already exist?" check would silently wave the run through.
set -euo pipefail

REPO="${1:?usage: release-preflight.sh <repo> <plugin> <version>}"
PLUGIN="${2:?usage: release-preflight.sh <repo> <plugin> <version>}"
VERSION="${3:?usage: release-preflight.sh <repo> <plugin> <version>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${GITHUB_REF:?GITHUB_REF must be set (GitHub Actions sets this automatically)}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH must be set (the calling workflow step sets this from github.event.repository.default_branch)}"

# 1. Only ever run from the default branch: this is what lets the src/<TAG>
#    marker (pushed later, at MAIN_SHA) carry the default-branch workflow
#    tree without any extra check (see the token/permission table in the plan).
if [[ "$GITHUB_REF" != "refs/heads/${DEFAULT_BRANCH}" ]]; then
  echo "::error::this workflow must run on the default branch (refs/heads/${DEFAULT_BRANCH}); got '${GITHUB_REF}'" >&2
  exit 1
fi

TAGS="$(cat)"

# 2. Version validation + previous-tag resolution.
PREV_TAG="$(printf '%s' "$TAGS" | bash "${SCRIPT_DIR}/prev-release-tag.sh" "$PLUGIN" "$VERSION")" || exit $?

TAG="${PLUGIN}--v${VERSION}"

# Echoes "exists" or "absent" on success (exit 0). On a genuine ambiguous
# failure (not a 404), prints ::error:: to stderr and returns 2 -- the
# caller must treat that as a hard failure, not as "absent".
ref_status() {
  local name="$1"
  local output
  output=$(gh api "repos/${REPO}/git/ref/tags/${name}" 2>&1)
  local status=$?
  if [[ $status -eq 0 ]]; then
    echo "exists"
    return 0
  fi
  if printf '%s' "$output" | grep -qi "404"; then
    echo "absent"
    return 0
  fi
  echo "::error::could not determine whether ref '${name}' exists (gh api failed): ${output}" >&2
  return 2
}

# 3. <TAG> must not already exist.
tag_status=$(ref_status "$TAG") || exit 1
if [[ "$tag_status" == "exists" ]]; then
  echo "::error::tag ${TAG} already exists. Delete it first or pick a new version." >&2
  exit 1
fi

# 4. src/<TAG> must not already exist. Nothing is ever deleted automatically;
#    an existing marker here means a previous run got partway through.
src_tag_status=$(ref_status "src/${TAG}") || exit 1
if [[ "$src_tag_status" == "exists" ]]; then
  echo "::error::src/${TAG} already exists. Nothing is deleted automatically; investigate manually." >&2
  exit 1
fi

# 5. A resolved previous release must already have its src/ marker --
#    generate-notes needs two endpoints on main, and there is no automatic
#    backfill (a ref at a historical commit needs human credentials; see
#    AGENTS.md). A first release (no PREV_TAG) is allowed through.
if [[ -n "$PREV_TAG" ]]; then
  prev_src_status=$(ref_status "src/${PREV_TAG}") || exit 1
  if [[ "$prev_src_status" == "absent" ]]; then
    {
      echo "::error::src/${PREV_TAG} does not exist. Bootstrap it once, manually, before releasing:"
      echo "  1. read head_sha from the Actions run of \`${PREV_TAG}\`"
      echo "  2. git tag src/${PREV_TAG} <head_sha>"
      echo "  3. git push origin src/${PREV_TAG}"
    } >&2
    exit 1
  fi
fi

MAIN_SHA="$(git rev-parse HEAD)"

echo "tag=${TAG}"
echo "prev_tag=${PREV_TAG}"
echo "main_sha=${MAIN_SHA}"
