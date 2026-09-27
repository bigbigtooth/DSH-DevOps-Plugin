/**
 * Remote execution wrapper (POSIX sh, Linux + macOS).
 *
 * Interface: wrapper.sh <mode> <dir>
 *   start <dir>  — runs <dir>/payload.sh in the BACKGROUND, records the
 *                  payload's pid/lstart identity, waits, then atomically
 *                  publishes exit facts and status=finished.
 *   stop   <dir> — identity-checked (pid + lstart) termination of the payload
 *                  and its descendants via process-tree enumeration; writes
 *                  stop.result facts. NEVER signals its own process group
 *                  (a detached wrapper shares it) and never trusts a bare
 *                  PID — PID reuse is defeated by the lstart identity.
 *
 * Files inside <dir> (atomic tmp+mv where it matters):
 *   pid pgid lstart token status output.log exitcode signal finished stop.result
 *
 * The wrapper never writes outside <dir>; payloads are uploaded per task.
 */
export function renderWrapper(): string {
  return String.raw`#!/bin/sh
# dsh-devops execution wrapper v1 — POSIX sh
set -u
MODE=
DIR=
[ $# -ge 1 ] && MODE=$1
[ $# -ge 2 ] && DIR=$2
[ -n "$MODE" ] || exit 64
[ -n "$DIR" ] || exit 64

now() { date +%s; }

publish() {
  printf '%s' "$2" > "$DIR/$1.tmp" && mv "$DIR/$1.tmp" "$DIR/$1"
}

lstart_of() {
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'
}

alive() {
  # alive <pid> <lstart>: 0 only when pid exists AND its start identity
  # matches. An empty recorded lstart means "identity never captured" —
  # refuse to judge (and therefore refuse to kill) on PID alone.
  P=$1
  L=$2
  [ -n "$P" ] || return 1
  CUR=$(lstart_of "$P")
  [ -n "$CUR" ] || return 1
  [ -n "$L" ] || return 1
  [ "$CUR" = "$L" ] || return 1
}

descendant_pids() {
  # all live descendants of $1 (breadth-first via ps), one line of pids
  ROOT=$1
  FRONT="$ROOT"
  OUT=""
  i=0
  while [ -n "$FRONT" ] && [ $i -lt 12 ]; do
    NEXT=""
    for P in $FRONT; do
      KIDS=$(ps -eo pid=,ppid= 2>/dev/null | awk -v p="$P" '$2==p {print $1}')
      for K in $KIDS; do
        OUT="$OUT $K"
        NEXT="$NEXT $K"
      done
    done
    FRONT=$NEXT
    i=$((i+1))
  done
  echo "$OUT"
}

case "$MODE" in
  start)
    [ -f "$DIR/payload.sh" ] || exit 65
    echo running > "$DIR/.status.tmp" && mv "$DIR/.status.tmp" "$DIR/status"
    : > "$DIR/output.log"
    sh "$DIR/payload.sh" >> "$DIR/output.log" 2>&1 &
    PAYLOAD=$!
    publish pid "$PAYLOAD"
    PGID=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')
    publish pgid "$PGID"
    LS=$(lstart_of "$PAYLOAD")
    j=0
    while [ -z "$LS" ] && [ $j -lt 20 ]; do
      sleep 0.1 2>/dev/null
      LS=$(lstart_of "$PAYLOAD")
      j=$((j+1))
    done
    publish lstart "$LS"
    wait "$PAYLOAD"
    RC=$?
    if [ "$RC" -gt 128 ]; then
      : > "$DIR/signal.tmp"; mv "$DIR/signal.tmp" "$DIR/signal"
      : > "$DIR/exitcode.tmp"; mv "$DIR/exitcode.tmp" "$DIR/exitcode"
    else
      publish exitcode "$RC"
    fi
    publish finished "$(now)"
    echo finished > "$DIR/.status.tmp" && mv "$DIR/.status.tmp" "$DIR/status"
    exit 0
    ;;
  stop)
    [ -f "$DIR/pid" ] || { echo no-task > "$DIR/.stop.tmp" && mv "$DIR/.stop.tmp" "$DIR/stop.result"; exit 0; }
    echo stopping > "$DIR/.status.tmp" && mv "$DIR/.status.tmp" "$DIR/status"
    PID=$(cat "$DIR/pid")
    LSTART=$(cat "$DIR/lstart" 2>/dev/null)
    ALIVE_BEFORE=0
    alive "$PID" "$LSTART" && ALIVE_BEFORE=1
    KILLED=0
    if [ "$ALIVE_BEFORE" = "1" ]; then
      # terminate descendants first (identity-checked), then the payload itself
      DESC=$(descendant_pids "$PID")
      for D in $DESC; do
        DL=$(lstart_of "$D")
        alive "$D" "$DL" && kill -TERM "$D" 2>/dev/null || true
      done
      kill -TERM "$PID" 2>/dev/null || true
      i=0
      while [ $i -lt 30 ]; do
        alive "$PID" "$LSTART" || break
        sleep 1 2>/dev/null
        i=$((i+1))
      done
      if alive "$PID" "$LSTART"; then
        kill -KILL "$PID" 2>/dev/null || true
      fi
      for D in $DESC; do
        DL=$(lstart_of "$D")
        alive "$D" "$DL" && kill -KILL "$D" 2>/dev/null || true
      done
      KILLED=1
    fi
    i=0
    while [ $i -lt 15 ]; do
      alive "$PID" "$LSTART" || break
      sleep 1 2>/dev/null
      i=$((i+1))
    done
    if alive "$PID" "$LSTART"; then
      AFTER=1
    else
      AFTER=0
    fi
    {
      echo "pidAliveBefore=$ALIVE_BEFORE"
      echo "killed=$KILLED"
      echo "pidAliveAfter=$AFTER"
      echo "token=$(cat "$DIR/token" 2>/dev/null)"
    } > "$DIR/.stop.tmp" && mv "$DIR/.stop.tmp" "$DIR/stop.result"
    echo stopped > "$DIR/.status.tmp" && mv "$DIR/.status.tmp" "$DIR/status"
    exit 0
    ;;
  status)
    if [ -f "$DIR/status" ]; then
      cat "$DIR/status"
    else
      echo absent
    fi
    exit 0
    ;;
  *)
    exit 64
    ;;
esac
`
}
