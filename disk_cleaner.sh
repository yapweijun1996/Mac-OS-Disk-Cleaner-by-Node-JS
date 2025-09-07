#!/bin/bash
set -u

SCRIPT_NAME="disk_cleaner.sh"
HOME_DIR="${HOME}"
LOG_PATH="${HOME_DIR}/Library/Logs/disk_cleaner.log"
DRY_RUN=1
APPLY=0
USE_TRASH=1
YES=0
NO_COLOR=0
VERBOSE=0
SCAN_OUTPUT=""
APPLY_FROM=""
MIN_SIZE=""
OLDER_THAN=""
INCLUDE_CATS=""
EXCLUDE_CATS=""
DEFAULT_CATS="user-caches,browsers,dev,pkg"
ENABLE_DOWNLOADS=0
ENABLE_DOCKER=0
SERVE=0
PORT=8000
EASY=0

# Colors
if [ -t 1 ]; then
  if command -v tput >/dev/null 2>&1; then
    ncolors=$(tput colors 2>/dev/null || echo 0)
  else
    ncolors=0
  fi
else
  ncolors=0
fi
if [ "$ncolors" -ge 8 ]; then
  RED="$(tput setaf 1)"
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  BLUE="$(tput setaf 4)"
  BOLD="$(tput bold)"
  RESET="$(tput sgr0)"
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

log() {
  local level="$1"; shift
  local msg="$*"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$(dirname "$LOG_PATH")" 2>/dev/null || true
  echo "[$ts] [$level] $msg" >>"$LOG_PATH"
  if [ "$NO_COLOR" -eq 1 ]; then
    echo "[$level] $msg"
  else
    case "$level" in
      INFO) echo "${BLUE}[$level]${RESET} $msg" ;;
      WARN) echo "${YELLOW}[$level]${RESET} $msg" ;;
      ERROR) echo "${RED}[$level]${RESET} $msg" ;;
      *) echo "[$level] $msg" ;;
    esac
  fi
}

usage() {
  cat <<'EOF'
disk_cleaner.sh - Safe macOS home directory cleanup (scan + plan apply)

Usage:
  # One-command: generate report.json in current folder, start local viewer, open browser
  ./disk_cleaner.sh --serve [--min-size 50M] [--older-than 30] [--include cats] [--exclude cats] [--port 8000]

  # Write scan report to a specific file
  ./disk_cleaner.sh --scan-output /path/to/report.json [--min-size 50M] [--older-than 30] [--include cats] [--exclude cats]

  # Auto-write scan report to Downloads with a timestamped filename
  ./disk_cleaner.sh --scan-to-downloads [--min-size 50M] [--older-than 30] [--include cats] [--exclude cats]

  # Apply a plan exported from the UI
  ./disk_cleaner.sh --apply-from /path/to/plan.(json|txt) [--apply] [--trash|--no-trash] [--yes]

Flags:
  --serve                 One-click mode: writes ./report.json, starts a local server and opens index.html?auto=1
  --port N                Port for --serve (default 8000)
  --easy                  Easiest mode: enables --serve with safe defaults (--downloads, --min-size 50M, --older-than 30)
  --scan-output FILE      Write scan report JSON to FILE
  --scan-to-downloads     Write scan to ~/Downloads/disk_cleaner_report-YYYYmmdd-HHMMSS.json (auto-created)
  --apply-from FILE       Apply cleanup plan from FILE (JSON with {"items":[{"path":...}]} or a .txt list of paths)
  --dry-run               Preview only (default)
  --apply                 Execute actions
  --trash                 Move items to ~/.Trash (default)
  --no-trash              Permanently delete (requires --yes and extra confirmation)
  --min-size N[k|M|G]     Only include files >= N size
  --older-than DAYS       Only include files with mtime older than DAYS
  --include LIST          Comma list: user-caches,browsers,dev,pkg,downloads,docker
  --exclude LIST          Comma list to exclude
  --log PATH              Log file path (default ~/Library/Logs/disk_cleaner.log)
  --no-color              Disable color output
  --yes                   Assume yes for confirmations
  --verbose               Verbose output
  --help                  Show this help

Examples:
  ./disk_cleaner.sh --easy
  ./disk_cleaner.sh --serve --min-size 50M --older-than 30 --downloads
  ./disk_cleaner.sh --scan-to-downloads --min-size 50M --older-than 30 --downloads
  ./disk_cleaner.sh --scan-output ~/Desktop/disk_cleaner_report.json --min-size 50M --older-than 30
  ./disk_cleaner.sh --apply-from /tmp/plan.txt --apply --trash --yes
EOF
}

ensure_home_scope() {
  local p="$1"
  case "$p" in
    "$HOME_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

deny_listed() {
  local p="$1"
  # Deny Photos, Mail, iCloud Documents, Desktop, Documents by default
  case "$p" in
    "$HOME_DIR"/Pictures/*|"$HOME_DIR"/*Photos*.photoslibrary/*) return 0 ;;
    "$HOME_DIR"/Library/Mail/*) return 0 ;;
    "$HOME_DIR"/Library/Mobile\ Documents/*) return 0 ;;
    "$HOME_DIR"/Desktop/*) return 0 ;;
    "$HOME_DIR"/Documents/*) return 0 ;;
    *) return 1 ;;
  esac
}

confirm() {
  local prompt="$1"
  if [ "$YES" -eq 1 ]; then
    return 0
  fi
  read -r -p "$prompt [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

humanize() {
  # bytes to human
  local b=$1
  local d=0
  local s=("B" "KB" "MB" "GB" "TB" "PB")
  while [ $(echo "$b >= 1024" | bc 2>/dev/null || echo 0) -eq 1 ] && [ $d -lt 5 ]; do
    b=$(echo "scale=2; $b/1024" | bc 2>/dev/null || echo $b)
    d=$((d+1))
  done
  printf "%s %s" "$b" "${s[$d]}"
}

json_escape() {
  # escape for JSON string
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e $'s/\r/\\r/g' -e $'s/\n/\\n/g' -e $'s/\t/\\t/g'
}

stat_bytes() {
  local f="$1"
  stat -f "%z" "$f" 2>/dev/null || echo 0
}

stat_mtime_epoch() {
  local f="$1"
  stat -f "%m" "$f" 2>/dev/null || echo 0
}

add_item_json() {
  local path="$1"
  local category="$2"
  local reason="$3"
  local trashable="$4"
  local bytes mtime
  bytes="$(stat_bytes "$path")"
  mtime="$(stat_mtime_epoch "$path")"
  local escpath escreason
  escpath="$(printf "%s" "$path" | json_escape)"
  escreason="$(printf "%s" "$reason" | json_escape)"
  printf '{\"path\":\"%s\",\"bytes\":%s,\"mtime\":%s,\"category\":\"%s\",\"reason\":\"%s\",\"trashable\":%s}\n' "$escpath" "$bytes" "$mtime" "$category" "$escreason" "$trashable" >> "$ITEMS_FILE"
}

build_find_filters() {
  local args=""
  if [ -n "$MIN_SIZE" ]; then
    args="$args -size +$MIN_SIZE"
  fi
  if [ -n "$OLDER_THAN" ]; then
    args="$args -mtime +$OLDER_THAN"
  fi
  echo "$args"
}

collect_user_caches() {
  local base="$HOME_DIR/Library/Caches"
  [ -d "$base" ] || return 0
  local filters
  filters="$(build_find_filters)"
  # files
  eval find -x \"\$base\" -type f $filters -print0 | while IFS= read -r -d '' f; do
    add_item_json "$f" "user-caches" "User Library cache" "true"
  done
}

collect_browsers() {
  for d in \
    "$HOME_DIR/Library/Caches/com.apple.Safari" \
    "$HOME_DIR/Library/Caches/Google/Chrome" \
    "$HOME_DIR/Library/Caches/Microsoft Edge" \
    "$HOME_DIR/Library/Caches/Firefox/Profiles" \
  ; do
    [ -d "$d" ] || continue
    local filters
    filters="$(build_find_filters)"
    eval find -x \"\$d\" -type f $filters -print0 | while IFS= read -r -d '' f; do
      add_item_json "$f" "browsers" "Browser cache" "true"
    done
  done
}

collect_dev() {
  for d in \
    "$HOME_DIR/Library/Developer/Xcode/DerivedData" \
    "$HOME_DIR/Library/Developer/Xcode/iOS DeviceSupport" \
    "$HOME_DIR/Library/Developer/CoreSimulator/Caches" \
  ; do
    [ -d "$d" ] || continue
    local filters
    filters="$(build_find_filters)"
    eval find -x \"\$d\" -type f $filters -print0 | while IFS= read -r -d '' f; do
      add_item_json "$f" "dev" "Developer cache" "true"
    done
  done
}

collect_pkg() {
  # Homebrew cache
  if command -v brew >/dev/null 2>&1; then
    local bcache
    bcache="$(brew --cache 2>/dev/null || true)"
    if [ -n "$bcache" ] && [ -d "$bcache" ]; then
      local filters
      filters="$(build_find_filters)"
      eval find -x \"\$bcache\" -type f $filters -print0 | while IFS= read -r -d '' f; do
        add_item_json "$f" "pkg" "Homebrew cache" "true"
      done
    fi
  fi
  # npm/yarn/pnpm/pip caches
  for d in \
    "$HOME_DIR/.npm/_cacache" \
    "$HOME_DIR/Library/Caches/npm" \
    "$HOME_DIR/Library/Caches/Yarn" \
    "$HOME_DIR/Library/pnpm/store" \
    "$HOME_DIR/Library/Caches/pnpm" \
    "$HOME_DIR/.cache/pip" \
    "$HOME_DIR/Library/Caches/pip" \
    "$HOME_DIR/.cache/pipx" \
  ; do
    [ -d "$d" ] || continue
    local filters
    filters="$(build_find_filters)"
    eval find -x \"\$d\" -type f $filters -print0 | while IFS= read -r -d '' f; do
      add_item_json "$f" "pkg" "Package manager cache" "true"
    done
  done
}

collect_downloads() {
  local d="$HOME_DIR/Downloads"
  [ -d "$d" ] || return 0
  local filters
  filters="$(build_find_filters)"
  eval find -x \"\$d\" -type f $filters -print0 | while IFS= read -r -d '' f; do
    add_item_json "$f" "downloads" "Downloads item" "true"
  done
}

scan() {
  local outfile="$1"
  # Ensure destination directory exists (e.g., ~/Downloads)
  mkdir -p "$(dirname "$outfile")" 2>/dev/null || true
  ITEMS_FILE="$(mktemp)"
  : >"$ITEMS_FILE"
  local cats
  cats="$(effective_categories)"
  log INFO "Scanning categories: $cats"
  IFS=',' read -r -a arr <<<"$cats"
  for c in "${arr[@]}"; do
    case "$c" in
      user-caches) collect_user_caches ;;
      browsers) collect_browsers ;;
      dev) collect_dev ;;
      pkg) collect_pkg ;;
      downloads) collect_downloads ;;
      docker) ;; # scanning docker not implemented here
    esac
  done
  local count bytes_total
  count=$(wc -l <"$ITEMS_FILE" | tr -d ' ')
  bytes_total=0
  while IFS= read -r line; do
    # extract bytes value
    b=$(printf "%s\n" "$line" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')
    [ -n "$b" ] || b=0
    bytes_total=$((bytes_total + b))
  done <"$ITEMS_FILE"
  {
    printf '{\n'
    printf '  "generatedAt": "%s",\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
   printf '  "home": "%s",\n' "$HOME_DIR"
    printf '  "totals": { "count": %s, "bytes": %s },\n' "$count" "$bytes_total"
    printf '  "categories": [%s],\n' "$(printf "%s" "$cats" | sed 's/[^,][^,]*/"&"/g')"
    printf '  "items": [\n'
    nl -ba "$ITEMS_FILE" | while IFS=$'\t' read -r num line; do
      printf "    %s" "$line"
      if [ "$num" -lt "$count" ]; then
        printf ","
      fi
      printf "\n"
    done
    printf '  ]\n'
    printf '}\n'
  } >"$outfile"
  rm -f "$ITEMS_FILE"
  log INFO "Scan complete: $count items, $(humanize "$bytes_total") total. Wrote: $outfile"
}

ensure_trash_dir() {
  local t="${HOME_DIR}/.Trash"
  if [ ! -d "$t" ]; then
    mkdir -p "$t" || return 1
  fi
  echo "$t"
}

safe_trash() {
  local p="$1"
  local t
  t="$(ensure_trash_dir)" || return 1
  local base name ext ts dest
  name="$(basename "$p")"
  ts="$(date +"%Y%m%d-%H%M%S")"
  dest="$t/${name}"
  if [ -e "$dest" ]; then
    dest="$t/${name}-${ts}"
  fi
  mv -f "$p" "$dest"
}

apply_plan() {
  local plan="$1"
  [ -f "$plan" ] || { log ERROR "Plan not found: $plan"; exit 1; }
  local list_file
  list_file="$(mktemp)"
  : >"$list_file"
  if grep -q '"items"' "$plan" 2>/dev/null; then
    # naive JSON path extractor
    sed -n 's/.*"path":[[:space:]]*"\([^"]*\)".*/\1/p' "$plan" >>"$list_file"
  else
    # assume plain text list
    grep -v '^[[:space:]]*$' "$plan" | grep -v '^[[:space:]]*#' >>"$list_file"
  fi
  local total=0 count=0
  while IFS= read -r p; do
    [ -e "$p" ] || { log WARN "Missing: $p"; continue; }
    if ! ensure_home_scope "$p"; then
      log WARN "Outside HOME, skipping: $p"
      continue
    fi
    if deny_listed "$p"; then
      log WARN "Deny-listed, skipping: $p"
      continue
    fi
    sz="$(stat_bytes "$p")"
    if [ "$DRY_RUN" -eq 1 ]; then
      log INFO "[DRY] Would remove: $p ($(humanize "$sz"))"
    else
      if [ "$USE_TRASH" -eq 1 ]; then
        safe_trash "$p" && log INFO "Trashed: $p ($(humanize "$sz"))" || log ERROR "Failed to trash: $p"
      else
        rm -rf "$p" && log INFO "Deleted: $p ($(humanize "$sz"))" || log ERROR "Failed to delete: $p"
      fi
    fi
    total=$((total + sz))
    count=$((count + 1))
  done <"$list_file"
  rm -f "$list_file"
  if [ "$DRY_RUN" -eq 1 ]; then
    log INFO "Apply (dry) complete: $count items, $(humanize "$total")"
  else
    log INFO "Apply complete: $count items, $(humanize "$total")"
  fi
}

effective_categories() {
  local cats="$DEFAULT_CATS"
  if [ "$ENABLE_DOWNLOADS" -eq 1 ]; then
    cats="$cats,downloads"
  fi
  if [ "$ENABLE_DOCKER" -eq 1 ]; then
    cats="$cats,docker"
  fi
  if [ -n "$INCLUDE_CATS" ]; then
    cats="$INCLUDE_CATS"
  fi
  if [ -n "$EXCLUDE_CATS" ]; then
    # remove excluded
    IFS=',' read -r -a ca <<<"$cats"
    IFS=',' read -r -a ex <<<"$EXCLUDE_CATS"
    local out=""
    for c in "${ca[@]}"; do
      skip=0
      for e in "${ex[@]}"; do
        [ "$c" = "$e" ] && { skip=1; break; }
      done
      [ $skip -eq 0 ] && { [ -z "$out" ] && out="$c" || out="$out,$c"; }
    done
    cats="$out"
  fi
  echo "$cats"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --serve) SERVE=1; shift ;;
      --port) PORT="$2"; shift 2 ;;
      --easy) EASY=1; shift ;;
      --scan-output) SCAN_OUTPUT="$2"; shift 2 ;;
      --scan-to-downloads) SCAN_OUTPUT="${HOME_DIR}/Downloads/disk_cleaner_report-$(date +%Y%m%d-%H%M%S).json"; shift ;;
      --apply-from) APPLY_FROM="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; APPLY=0; shift ;;
      --apply) DRY_RUN=0; APPLY=1; shift ;;
      --trash) USE_TRASH=1; shift ;;
      --no-trash) USE_TRASH=0; shift ;;
      --min-size) MIN_SIZE="$2"; shift 2 ;;
      --older-than) OLDER_THAN="$2"; shift 2 ;;
      --include) INCLUDE_CATS="$2"; shift 2 ;;
      --exclude) EXCLUDE_CATS="$2"; shift 2 ;;
      --log) LOG_PATH="$2"; shift 2 ;;
      --no-color) NO_COLOR=1; shift ;;
      --yes) YES=1; shift ;;
      --verbose) VERBOSE=1; shift ;;
      --downloads) ENABLE_DOWNLOADS=1; shift ;;
      --docker) ENABLE_DOCKER=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) log ERROR "Unknown arg: $1"; usage; exit 1 ;;
    esac
  done
}

double_confirm_no_trash() {
  if [ "$USE_TRASH" -eq 0 ]; then
    [ "$YES" -eq 1 ] || confirm "You are about to permanently delete items. Continue?" || exit 1
  fi
}

main() {
  parse_args "$@"

  # Easy mode: set safe defaults if user didn't specify them; serve UI automatically.
  if [ "${EASY:-0}" -eq 1 ]; then
    [ -n "${MIN_SIZE}" ] || MIN_SIZE="50M"
    [ -n "${OLDER_THAN}" ] || OLDER_THAN="30"
    [ "${ENABLE_DOWNLOADS}" -eq 1 ] || ENABLE_DOWNLOADS=1
    SERVE=1
  fi

  # One-click serve mode: generate ./report.json (or user-provided --scan-output),
  # start a tiny local server, and open the browser with auto-load.
  if [ "$SERVE" -eq 1 ] ; then
    if [ -z "$SCAN_OUTPUT" ]; then
      SCAN_OUTPUT="${PWD}/report.json"
    fi
    scan "$SCAN_OUTPUT"

    if [ ! -f "${PWD}/index.html" ]; then
      log ERROR "index.html not found in ${PWD}. Run from the project folder."
      exit 1
    fi

    # Prefer python3; fallback to python; otherwise open file directly.
    if command -v python3 >/dev/null 2>&1; then
      SRV_CMD=(python3 -m http.server "$PORT")
      START_SERVER=1
    elif command -v python >/dev/null 2>&1; then
      SRV_CMD=(python -m SimpleHTTPServer "$PORT")
      START_SERVER=1
    else
      START_SERVER=0
    fi

    if [ "${START_SERVER}" -eq 1 ]; then
      log INFO "Serving UI at http://localhost:${PORT} (Ctrl+C to stop)"
      "${SRV_CMD[@]}" &
      SRV_PID=$!
      if command -v open >/dev/null 2>&1; then
        open "http://localhost:${PORT}/index.html?auto=1"
      fi
      wait "$SRV_PID"
      exit 0
    else
      log WARN "No Python found. Opening index.html directly. In the UI, click 'Load Scan Report' and choose: $SCAN_OUTPUT"
      if command -v open >/dev/null 2>&1; then
        open "${PWD}/index.html"
      fi
      exit 0
    fi
  fi

  # Standard CLI modes
  if [ -z "$SCAN_OUTPUT" ] && [ -z "$APPLY_FROM" ]; then
    usage
    exit 1
  fi

  if [ -n "$SCAN_OUTPUT" ]; then
    scan "$SCAN_OUTPUT"
  fi

  if [ -n "$APPLY_FROM" ]; then
    double_confirm_no_trash
    apply_plan "$APPLY_FROM"
  fi
}

main "$@"