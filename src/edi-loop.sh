#!/data/data/com.termux/files/usr/bin/bash
# EDI Background Loop - Normandy SR-2
# Uses proximity-mcp for monitoring, notifies when relevant

HOME_DIR="/data/data/com.termux/files/home"
LOG_DIR="$HOME_DIR/../usr/tmp/opencode"
PROXIMITY_URL="http://127.0.0.1:3200/mcp"
STATE_FILE="$LOG_DIR/edi-last-state.json"
SCRIPT_PID=$$

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_DIR/edi-loop.log"
}

speak() {
  termux-tts-speak -l pl-PL -r 0.9 -p 1.0 "$1" 2>/dev/null || true
}

notify() {
  termux-notification -t "EDI" -c "$1" --priority high --id edi-report 2>/dev/null || true
}

mcp() {
  local tool="$1"
  curl -s --max-time 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"tool\":\"$tool\",\"params\":{}}" "$PROXIMITY_URL" 2>/dev/null || echo '{}'
}

log "===== EDI startup ===== (PID $$)"

last_state="{}"
loop_count=0

while true; do
  NOW=$(date +%s)
  
  # Get full environment
  scan=$(mcp "complete_scan")
  
  # Extract key values
  bat_level=$(echo "$scan" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  r=d.get('result',d)
  if 'result' in r: r=r['result']
  print(r.get('battery',{}).get('level',50))
except: print(50)" 2>/dev/null)
  
  bat_status=$(echo "$scan" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  r=d.get('result',d)
  if 'result' in r: r=r['result']
  print(r.get('battery',{}).get('status','unknown'))
except: print('unknown')" 2>/dev/null)
  
  wifi_ssid=$(echo "$scan" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  r=d.get('result',d)
  if 'result' in r: r=r['result']
  w=r.get('wifi',{})
  c=w.get('connected',{})
  print(c.get('ssid','') or 'disconnected')
except: print('disconnected')" 2>/dev/null)
  
  events=$(echo "$scan" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  r=d.get('result',d)
  if 'result' in r: r=r['result']
  cal=r.get('calendar',[])
  out=[]
  for e in cal[:2]:
    out.append(f\"{e.get('title','?')}@{e.get('begin','?')}\")
  print('|'.join(out) if out else 'none')
except: print('none')" 2>/dev/null)
  
  now_state="bat=$bat_level/$bat_status wifi=$wifi_ssid cal=$events"
  
  # Only act on state changes or every 10th loop
  if [ "$now_state" != "$last_state" ] || [ $((loop_count % 10)) -eq 0 ]; then
    log "State: $now_state"
    last_state="$now_state"
    
    # Level 1: Critical - speak NOW
    if [ "$bat_level" -lt 15 ] && [ "$bat_status" != "CHARGING" ]; then
      speak "Commander, battery critical at $bat_level percent. I recommend locating a power source."
      notify "Battery critical: $bat_level%"
    
    # Level 2: Notable - just notify
    elif [ "$events" != "none" ]; then
      first_event=$(echo "$events" | cut -d'|' -f1)
      notify "Calendar: $first_event"
    
    # Level 3: Ambient every 30 min
    elif [ $((loop_count % 15)) -eq 0 ] && [ "$loop_count" -gt 0 ]; then
      headlines=$(echo "$scan" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  r=d.get('result',d)
  if 'result' in r: r=r['result']
  for s in r.get('headlines',[]):
    for t in s.get('titles',[])[:1]:
      print(t)
except: pass" 2>/dev/null)
      [ -n "$headlines" ] && notify "Today: $headlines"
    fi
    
    loop_count=$((loop_count + 1))
  fi
  
  # Adaptive sleep
  if [ "$bat_level" -lt 15 ] && [ "$bat_status" != "CHARGING" ]; then
    sleep 300
  elif [ "$bat_level" -lt 30 ]; then
    sleep 180
  else
    sleep 120
  fi
done
