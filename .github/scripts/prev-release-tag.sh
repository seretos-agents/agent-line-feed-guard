#!/usr/bin/env bash
# prev-release-tag.sh <plugin> <new-version>
#
# Reads a tag list on stdin (one tag per line, e.g. `git tag -l` in CI) and
# prints the highest `<plugin>--v<semver>` tag whose SemVer 2.0 precedence is
# STRICTLY BELOW <new-version>, or nothing if there is none (first release).
#
# Excluded, unconditionally:
#   - `src/*` marker tags
#   - tags belonging to any other plugin
#   - tags that are not strict SemVer (grammar below)
#   - the tag being created itself, and any tag whose precedence is >= the
#     new version (an out-of-order/hotfix tag on a newer line is never
#     "previous" relative to an older new version)
#
# <new-version> itself must be strict SemVer; an invalid value prints
# `::error::` and exits 2. This is the single place the strict grammar lives
# — release-preflight.sh delegates version validation here.
set -euo pipefail

PLUGIN="${1:?usage: prev-release-tag.sh <plugin> <new-version>}"
NEW_VERSION="${2:?usage: prev-release-tag.sh <plugin> <new-version>}"

# Strict SemVer 2.0 grammar, no build metadata: MAJOR.MINOR.PATCH[-PRERELEASE]
# Numeric identifiers must not have leading zeros (except the single digit
# "0"); alphanumeric identifiers may contain hyphens and letters.
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'

is_valid_semver() {
  [[ "$1" =~ $SEMVER_RE ]]
}

if ! is_valid_semver "$NEW_VERSION"; then
  echo "::error::invalid semver: '${NEW_VERSION}' (expected MAJOR.MINOR.PATCH[-PRERELEASE])" >&2
  exit 2
fi

# Splits "MAJOR.MINOR.PATCH[-PRERELEASE]" (already validated) into the
# globals CORE (array of 3), PRERELEASE (string, may be empty) and HAS_PRE
# (0/1).
split_semver() {
  local v="$1"
  local core="${v%%-*}"
  if [[ "$v" == *-* ]]; then
    PRERELEASE="${v#*-}"
    HAS_PRE=1
  else
    PRERELEASE=""
    HAS_PRE=0
  fi
  IFS='.' read -r -a CORE <<< "$core"
}

# Compares two dot-separated prerelease identifiers per SemVer 2.0 §11.
# Echoes -1, 0 or 1. Numeric identifiers compare numerically and always
# have lower precedence than alphanumeric ones (rc.2 < rc.10; "1" < "rc").
compare_identifier() {
  local a="$1" b="$2"
  local a_num=0 b_num=0
  [[ "$a" =~ ^[0-9]+$ ]] && a_num=1
  [[ "$b" =~ ^[0-9]+$ ]] && b_num=1
  if [[ $a_num -eq 1 && $b_num -eq 1 ]]; then
    if [[ "$a" -lt "$b" ]]; then echo -1; elif [[ "$a" -gt "$b" ]]; then echo 1; else echo 0; fi
  elif [[ $a_num -eq 1 ]]; then
    echo -1
  elif [[ $b_num -eq 1 ]]; then
    echo 1
  else
    if [[ "$a" < "$b" ]]; then echo -1; elif [[ "$a" > "$b" ]]; then echo 1; else echo 0; fi
  fi
}

# Compares two full, already-validated semver strings. Echoes -1, 0 or 1.
semver_compare() {
  split_semver "$1"
  local a_core=("${CORE[@]}") a_pre="$PRERELEASE" a_has=$HAS_PRE
  split_semver "$2"
  local b_core=("${CORE[@]}") b_pre="$PRERELEASE" b_has=$HAS_PRE

  local i
  for i in 0 1 2; do
    if [[ "${a_core[$i]}" -lt "${b_core[$i]}" ]]; then echo -1; return; fi
    if [[ "${a_core[$i]}" -gt "${b_core[$i]}" ]]; then echo 1; return; fi
  done

  if [[ $a_has -eq 0 && $b_has -eq 0 ]]; then echo 0; return; fi
  if [[ $a_has -eq 0 ]]; then echo 1; return; fi   # a release outranks its own prerelease
  if [[ $b_has -eq 0 ]]; then echo -1; return; fi

  local a_ids b_ids
  IFS='.' read -r -a a_ids <<< "$a_pre"
  IFS='.' read -r -a b_ids <<< "$b_pre"
  local n=${#a_ids[@]} m=${#b_ids[@]}
  local max=$n
  [[ $m -gt $max ]] && max=$m
  for ((i = 0; i < max; i++)); do
    if [[ $i -ge $n ]]; then echo -1; return; fi
    if [[ $i -ge $m ]]; then echo 1; return; fi
    local c
    c=$(compare_identifier "${a_ids[$i]}" "${b_ids[$i]}")
    if [[ "$c" != "0" ]]; then
      echo "$c"
      return
    fi
  done
  echo 0
}

best=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  case "$line" in
    "$PLUGIN--v"*) ;;
    *) continue ;;
  esac
  ver="${line#"$PLUGIN"--v}"
  is_valid_semver "$ver" || continue

  cmp=$(semver_compare "$ver" "$NEW_VERSION")
  [[ "$cmp" -lt 0 ]] || continue

  if [[ -z "$best" ]]; then
    best="$ver"
  else
    c=$(semver_compare "$ver" "$best")
    [[ "$c" -gt 0 ]] && best="$ver"
  fi
done

if [[ -n "$best" ]]; then
  echo "${PLUGIN}--v${best}"
fi
