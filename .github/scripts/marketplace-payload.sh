#!/usr/bin/env bash
# marketplace-payload.sh
#
# Builds the marketplace `repository_dispatch` JSON payload from env vars
# (NAME, DESC, REPO, VERSION, CHANGELOG) with `jq -n --arg`, never a heredoc
# -- a heredoc has to be manually shell-escaped for every hostile character
# a changelog or description can contain (backticks, quotes, backslashes,
# `$(...)`, `${VAR}`, CRLF, unicode); `jq -n --arg` passes each value through
# as an inert argv string that jq JSON-encodes itself.
#
# `changelog` is included only when CHANGELOG is non-empty -- an empty
# changelog omits the key entirely rather than sending an empty string.
set -euo pipefail

NAME="${NAME:?NAME must be set}"
DESC="${DESC:?DESC must be set}"
REPO="${REPO:?REPO must be set}"
VERSION="${VERSION:?VERSION must be set}"
CHANGELOG="${CHANGELOG:-}"

REF="${NAME}--v${VERSION}"

HAS_CHANGELOG="false"
[[ -n "$CHANGELOG" ]] && HAS_CHANGELOG="true"

jq -n \
  --arg name "$NAME" \
  --arg desc "$DESC" \
  --arg repo "$REPO" \
  --arg version "$VERSION" \
  --arg ref "$REF" \
  --arg icon "https://raw.githubusercontent.com/${REPO}/${REF}/assets/icon.png" \
  --arg description_url "https://raw.githubusercontent.com/${REPO}/${REF}/description.md" \
  --arg changelog "$CHANGELOG" \
  --argjson has_changelog "$HAS_CHANGELOG" \
  '{
    event_type: "plugin-release",
    client_payload: (
      {
        name: $name,
        description: $desc,
        repo: $repo,
        category: "hook",
        tags: ["claude", "hooks", "windows", "line-endings"],
        version: $version,
        ref: $ref,
        icon: $icon,
        description_url: $description_url
      }
      + (if $has_changelog then {changelog: $changelog} else {} end)
    )
  }'
