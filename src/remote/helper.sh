#!/bin/sh
# dsh-ssh-fleet remote helper.
#
# Uploaded by the host-side plugin into ~/.cache/dsh-ssh-fleet/ and invoked as
#   sh helper.sh <op> [args...]
# Only POSIX sh, coreutils-style tools (GNU or BSD stat) and optionally
# setsid/perl are required. Nothing else is installed on the server.
#
# Exit codes (mapped to FsError codes on the host):
#   0 ok, 10 not found, 11 not a directory, 12 not a regular file,
#   13 permission denied, 14 too large, 15 stale version, 16 already exists,
#   17 I/O error, 64 usage error
set -u

STATE="${HOME}/.cache/dsh-ssh-fleet"
RUN="$STATE/run"

# GNU and busybox stat accept -c; BSD/macOS stat uses -f.
if stat -c %s / >/dev/null 2>&1; then
  FLAVOR=gnu
  st() { stat -L -c '%F|%s|%d:%i:%s:%Y:%Z:%y' -- "$@" 2>/dev/null; }
  lst() { stat -c '%F|%s|%d:%i:%s:%Y:%Z:%y' -- "$@" 2>/dev/null; }
  stn() { stat -L -c '%F|%s|%d:%i:%s:%Y:%Z:%y|%n' -- "$@" 2>/dev/null; }
  fmode() { stat -L -c '%a' -- "$1" 2>/dev/null; }
else
  FLAVOR=bsd
  st() { stat -L -f '%HT|%z|%d:%i:%z:%m:%c:%Fm' -- "$@" 2>/dev/null; }
  lst() { stat -f '%HT|%z|%d:%i:%z:%m:%c:%Fm' -- "$@" 2>/dev/null; }
  stn() { stat -L -f '%HT|%z|%d:%i:%z:%m:%c:%Fm|%N' -- "$@" 2>/dev/null; }
  fmode() { stat -L -f '%Lp' -- "$1" 2>/dev/null; }
fi

# Canonicalize an absolute path: resolve symlinks of every existing prefix,
# keep the missing tail lexically (like realpath -m), never fail.
canon() {
  _depth=${2:-0}
  if [ "$_depth" -gt 40 ]; then printf '%s\n' "$1"; return; fi
  _p=$1
  if [ -d "$_p" ] && [ ! -L "$_p" ]; then (cd -P -- "$_p" 2>/dev/null && pwd -P) && return; fi
  if [ -L "$_p" ]; then
    _t=$(readlink -- "$_p")
    case $_t in
      /*) canon "$_t" $((_depth + 1)) ;;
      *) canon "$(dirname -- "$_p")/$_t" $((_depth + 1)) ;;
    esac
    return
  fi
  _d=$(dirname -- "$_p"); _b=$(basename -- "$_p")
  if [ "$_d" = "$_p" ]; then printf '%s\n' "$_p"; return; fi
  if [ -d "$_d" ]; then _dd=$(cd -P -- "$_d" 2>/dev/null && pwd -P) || _dd=$_d
  else _dd=$(canon "$_d" $((_depth + 1))); fi
  case $_b in
    .) printf '%s\n' "$_dd" ;;
    ..) dirname -- "$_dd" ;;
    *) case $_dd in /) printf '/%s\n' "$_b" ;; *) printf '%s/%s\n' "$_dd" "$_b" ;; esac ;;
  esac
}

errno_of() {
  # Classify why $1 cannot be read.
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 10; fi
  if [ ! -r "$1" ]; then return 13; fi
  return 17
}

op=${1:-}
[ $# -gt 0 ] && shift

case $op in
  info)
    printf 'os=%s\n' "$(uname -s)"
    printf 'arch=%s\n' "$(uname -m)"
    printf 'home=%s\n' "$HOME"
    printf 'flavor=%s\n' "$FLAVOR"
    printf 'shell=%s\n' "${SHELL:-}"
    for c in bash bwrap rg setsid perl tar mkfifo mktemp; do
      printf 'cmd.%s=%s\n' "$c" "$(command -v "$c" 2>/dev/null || true)"
    done
    ;;

  resolve)
    canon "$1"
    ;;

  stat)
    if [ ! -e "$1" ]; then exit 10; fi
    st "$1" || exit 17
    ;;

  lstat)
    if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 10; fi
    lst "$1" || exit 17
    ;;

  list)
    [ -e "$1" ] || exit 10
    [ -d "$1" ] || exit 11
    cd -- "$1" 2>/dev/null || exit 13
    # Batched stat of every followable entry (find splits huge directories).
    find . ! -name . -prune -exec sh -c '
      if stat -c %s / >/dev/null 2>&1; then stat -L -c "%F|%s|%d:%i:%s:%Y:%Z:%y|%n" -- "$@" 2>/dev/null
      else stat -L -f "%HT|%z|%d:%i:%z:%m:%c:%Fm|%N" -- "$@" 2>/dev/null; fi
      true' sh {} + || exit 17
    # Symlinks: report their canonical target; dangling ones as "other".
    find . ! -name . -prune -type l -print | while IFS= read -r f; do
      f=${f#./}
      if [ -e "$f" ]; then printf 'L|%s|%s\n' "$(canon "$PWD/$f")" "$f"
      else printf 'D|0|-|%s\n' "$f"; fi
    done
    ;;

  read)
    # read <path> <maxBytes|-1>: prints "<size>\n" then the content.
    [ -e "$1" ] || exit 10
    [ -f "$1" ] || exit 12
    [ -r "$1" ] || exit 13
    size=$(wc -c < "$1" | tr -d ' ') || exit 17
    if [ "$2" -ge 0 ] && [ "$size" -gt "$2" ]; then printf '%s\n' "$size"; exit 14; fi
    printf '%s\n' "$size"
    cat -- "$1" || exit 17
    ;;

  range)
    # range <path> <offset> <length>
    [ -e "$1" ] || exit 10
    [ -f "$1" ] || exit 12
    [ -r "$1" ] || exit 13
    [ "$3" -gt 0 ] || exit 0
    tail -c +$(($2 + 1)) -- "$1" | head -c "$3"
    ;;

  readv)
    # readv <path> <maxBasisBytes>: version header plus an optional diff basis.
    if [ ! -e "$1" ]; then printf 'absent\n'; exit 0; fi
    line=$(st "$1") || exit 17
    printf 'present|%s\n' "$line"
    case $line in
      [Rr]egular*)
        size=${line#*|}; size=${size%%|*}
        if [ "$size" -lt "$2" ] && [ -r "$1" ]; then cat -- "$1"; fi
        ;;
    esac
    ;;

  write)
    # write <path> <expect: -|absent|<version>> ; content on stdin.
    p=$1; expect=$2
    d=$(dirname -- "$p")
    mkdir -p -- "$d" 2>/dev/null || exit 13
    [ -d "$d" ] || exit 11
    if [ -e "$p" ] && [ ! -f "$p" ]; then exit 12; fi
    case $expect in
      -) ;;
      absent) [ -e "$p" ] && exit 16 ;;
      *)
        [ -e "$p" ] || exit 15
        cur=$(st "$p") || exit 17
        cur=${cur#*|}; cur=${cur#*|}
        [ "$cur" = "$expect" ] || exit 15
        ;;
    esac
    tmp=$(mktemp "$d/.dsh-fleet.XXXXXX" 2>/dev/null) || exit 13
    if ! cat > "$tmp"; then rm -f -- "$tmp"; exit 17; fi
    if [ -e "$p" ]; then m=$(fmode "$p") && chmod "$m" "$tmp" 2>/dev/null
    else chmod "$(printf '%o' $((0666 & ~$(umask))))" "$tmp" 2>/dev/null; fi
    if [ "$expect" = absent ]; then
      # Hard link publication refuses an existing target atomically.
      if ! ln -- "$tmp" "$p" 2>/dev/null; then rm -f -- "$tmp"; [ -e "$p" ] && exit 16; exit 17; fi
      rm -f -- "$tmp"
    else
      mv -f -- "$tmp" "$p" || { rm -f -- "$tmp"; exit 17; }
    fi
    line=$(st "$p") || exit 17
    line=${line#*|}; printf '%s\n' "${line#*|}"
    ;;

  mkdir)
    # mkdir <parent> <name>: create one child directory, print its path.
    [ -d "$1" ] || exit 10
    [ -e "$1/$2" ] && exit 16
    mkdir -- "$1/$2" 2>/dev/null || { [ -w "$1" ] || exit 13; exit 17; }
    canon "$1/$2"
    ;;

  which)
    # Resolve like execvp: an executable regular file, never a builtin.
    case $1 in
      */*) [ -f "$1" ] && [ -x "$1" ] || exit 10; canon "$1"; exit 0 ;;
    esac
    IFS=:
    for d in $PATH; do
      [ -n "$d" ] || d=.
      if [ -f "$d/$1" ] && [ -x "$d/$1" ]; then unset IFS; canon "$d/$1"; exit 0; fi
    done
    exit 10
    ;;

  run)
    # run <id> <stdin: ignore|data|pipe> <graceSeconds> <cwd> [-u NAME|K=V]... -- argv...
    id=$1; mode=$2; grace=$3; cwd=$4; shift 4
    mkdir -p "$RUN" 2>/dev/null
    in=
    # Keep the channel's stdin on fd 3: asynchronous lists get /dev/null as
    # stdin unless redirected explicitly.
    exec 3<&0
    n=0
    while [ $# -gt 0 ] && [ "$1" != -- ]; do
      n=$((n + 1)); eval "e_$n=\$1"; shift
    done
    [ $# -gt 0 ] && shift
    if [ $# -eq 0 ]; then echo 'dsh-ssh-fleet: empty argv' >&2; exit 64; fi
    # Rebuild "$@" as: env [entries...] argv...
    i=$n
    while [ "$i" -gt 0 ]; do eval "set -- \"\$e_$i\" \"\$@\""; i=$((i - 1)); done
    cd -- "$cwd" 2>/dev/null || { printf 'dsh-ssh-fleet: cannot change directory to %s\n' "$cwd" >&2; exit 126; }
    if [ "$mode" = data ]; then
      IFS= read -r len || len=0
      in=$(mktemp "$RUN/in.XXXXXX") || exit 17
      head -c "$len" > "$in"
    fi
    o="$RUN/$id.o"; e="$RUN/$id.e"
    rm -f -- "$o" "$e"
    mkfifo "$o" "$e" || exit 17
    cat "$o" 3<&- & co=$!
    cat "$e" >&2 3<&- & ce=$!
    if command -v setsid >/dev/null 2>&1; then grp="setsid"
    elif command -v perl >/dev/null 2>&1; then grp="perl -e setpgrp(0,0);exec(@ARGV)or(die(qq(exec:\$!\\n)))"
    else grp=""; fi
    case $mode in
      pipe) $grp env "$@" <&3 >"$o" 2>"$e" 3<&- & ;;
      data) $grp env "$@" <"$in" >"$o" 2>"$e" 3<&- & ;;
      *) $grp env "$@" </dev/null >"$o" 2>"$e" 3<&- & ;;
    esac
    pg=$!
    printf '%s\n' "$pg" > "$RUN/$id"
    if [ "$mode" != pipe ]; then
      # Lifeline: the host keeps our stdin open; EOF means the client is gone.
      ( while IFS= read -r _ <&3; do :; done
        : > "$RUN/$id.lost"
        kill -TERM -"$pg" 2>/dev/null || kill -TERM "$pg" 2>/dev/null
        sleep "$grace"
        kill -KILL -"$pg" 2>/dev/null || kill -KILL "$pg" 2>/dev/null
        rm -f -- "$RUN/$id" ) >/dev/null 2>&1 &
      wd=$!
    fi
    wd=${wd:-}
    wait "$pg"; rc=$?
    # Survivors may keep the pipes open; bound the drain like a local provider.
    ( sleep "$grace"; kill "$co" "$ce" 2>/dev/null ) >/dev/null 2>&1 &
    t=$!
    wait "$co" "$ce" 2>/dev/null
    kill "$t" 2>/dev/null
    # Release the channel's stdin so the client sees the exit; survivors stay
    # reachable through the recorded group (op "signal").
    if [ -n "$wd" ]; then
      # A fired lifeline owns the TERM-to-KILL escalation; let it finish.
      if [ -f "$RUN/$id.lost" ]; then wait "$wd" 2>/dev/null; rm -f -- "$RUN/$id.lost"
      else kill "$wd" 2>/dev/null; fi
    fi
    exec 3<&-
    rm -f -- "$o" "$e" ${in:+"$in"}
    [ "$mode" = pipe ] || [ -f "$RUN/$id" ] && ! kill -0 -"$pg" 2>/dev/null && rm -f -- "$RUN/$id"
    exit "$rc"
    ;;

  term)
    # term <id> [cwd] [-u NAME|K=V]... -- argv... : PTY session entry.
    id=$1; cwd=$2; shift 2
    mkdir -p "$RUN" 2>/dev/null
    cd -- "$cwd" 2>/dev/null || { printf 'dsh-ssh-fleet: cannot change directory to %s\n' "$cwd" >&2; exit 126; }
    printf '%s\n' "$$" > "$RUN/$id"
    n=0
    while [ $# -gt 0 ] && [ "$1" != -- ]; do n=$((n + 1)); eval "e_$n=\$1"; shift; done
    [ $# -gt 0 ] && shift
    i=$n
    while [ "$i" -gt 0 ]; do eval "set -- \"\$e_$i\" \"\$@\""; i=$((i - 1)); done
    exec env "$@"
    ;;

  signal)
    # signal <id> <SIG>: signal the process group recorded for a run.
    pg=$(cat "$RUN/$1" 2>/dev/null) || exit 10
    kill -"$2" -"$pg" 2>/dev/null || kill -"$2" "$pg" 2>/dev/null || exit 10
    ;;

  alive)
    # alive <id>: exit 0 while any member of the recorded group exists.
    pg=$(cat "$RUN/$1" 2>/dev/null) || exit 10
    if kill -0 -"$pg" 2>/dev/null || kill -0 "$pg" 2>/dev/null; then exit 0; fi
    rm -f -- "$RUN/$1"
    exit 10
    ;;

  fg)
    # fg <id>: foreground process group of a PTY session's shell.
    pid=$(cat "$RUN/$1" 2>/dev/null) || exit 10
    g=$(ps -o tpgid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$g" ] && [ "$g" -gt 0 ] 2>/dev/null || exit 10
    printf '%s\n' "$g"
    ;;

  fgsignal)
    # fgsignal <id> <SIG>: signal the PTY session's foreground group.
    pid=$(cat "$RUN/$1" 2>/dev/null) || exit 10
    g=$(ps -o tpgid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$g" ] && [ "$g" -gt 0 ] 2>/dev/null || exit 10
    kill -"$2" -"$g" 2>/dev/null || exit 10
    printf '%s\n' "$g"
    ;;

  forget)
    rm -f -- "$RUN/$1"
    ;;

  *)
    echo "dsh-ssh-fleet helper: unknown op '$op'" >&2
    exit 64
    ;;
esac
