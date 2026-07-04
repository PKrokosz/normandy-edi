#!/data/data/com.termux/files/usr/bin/bash
# EDI Background Monitoring Loop
# Normandy SR-2 - Enhanced Defense Intelligence
set -euo pipefail

HOME_DIR="/data/data/com.termux/files/home"
PROJECT_DIR="$HOME_DIR/normandy-edi"
LOG_DIR="$HOME_DIR/../usr/tmp/opencode"
PROXIMITY_URL="http://127.0.0.1:3200/mcp"
PERSONA_FILE="$PROJECT_DIR/config/edi-persona.md"
SAMPLE_INTERVAL=120  # seconds between ambient checks (2 min)
HEAVY_INTERVAL=1800  # heavy scan with news (30 min)

LAST_HEAVY=0
SCREEN_WAS_ON=false

log() {
    echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_DIR/edi-loop.log"
}

speak() {
    termux-tts-speak -l pl-PL -r 0.9 -p 1.0 "$1" 2>/dev/null || true
}

notify() {
    termux-notification -t "EDI" -c "$1" --priority low --id edi-pending 2>/dev/null || true
}

notify_high() {
    termux-notification -t "EDI" -c "$1" --priority high --alert-once --id edi-alert 2>/dev/null || true
}

is_screen_on() {
    dumpsys window 2>/dev/null | grep -q 'mDreamingLockscreen=false\|mInteractive=true'
}

call_mcp() {
    local tool="$1"
    local params="${2:-{}}"
    curl -s --max-time 15 -X POST -H 'Content-Type: application/json' \
        -d "{\"tool\":\"$tool\",\"params\":$params}" \
        "$PROXIMITY_URL" 2>/dev/null || echo '{"result":{"error":"unavailable"}}'
}

call_opencode() {
    local context="$1"
    local persona
    persona=$(cat "$PERSONA_FILE")

    log "Invoking opencode for analysis..."

    local result
    result=$(opencode --agent edi 2>&1 <<EOF
$persona

## Current Context Report
${context}

## Instructions
Analyze the situation as EDI. If you have something relevant to communicate, output:

SPEAK: "your message in character"

If it's urgent (battery critical, security threat), prefix with:
URGENT

If nothing needs saying:
SILENT
EOF
) || result="SILENT"

    echo "$result"
}

execute_edi_response() {
    local response="$1"

    if [[ "$response" == "SILENT" ]]; then
        log "EDI: nothing to report"
        return
    fi

    local urgent=false
    if echo "$response" | grep -q "^URGENT"; then
        urgent=true
    fi

    local message
    message=$(echo "$response" | grep "^SPEAK:" | sed 's/^SPEAK: *"//' | sed 's/"$//')

    if [ -z "$message" ]; then
        log "EDI: response without SPEAK: $response"
        return
    fi

    if $urgent; then
        log "EDI [URGENT]: $message"
        notify_high "$message"
        if is_screen_on; then
            speak "$message"
        fi
    else
        log "EDI: $message"
        notify "$message"
        if is_screen_on; then
            speak "$message"
        fi
    fi
}

# --- Main Loop ---
log "===== EDI LOOP STARTED ====="

# Kill leftover instances
pkill -f "edi-loop.sh" 2>/dev/null || true

while true; do
    NOW=$(date +%s)

    # Get complete environment snapshot from proximity-mcp
    log "Scanning environment..."
    local scan_result
    scan_result=$(call_mcp "complete_scan" "{}")

    # Format timestamp
    local formatted_time
    formatted_time=$(date '+%A, %Y-%m-%d %H:%M')

    # Build context report for LLM
    local context="Timestamp: $formatted_time

## Systems
"

    # Parse and format scan result via python for clean output
    context+=$(python3 -c "
import sys, json
try:
    data = json.loads('''$scan_result''')
    r = data.get('result', data)
    if 'result' in r: r = r['result']
    lines = []

    w = r.get('wifi', {})
    c = w.get('connected')
    if c:
        lines.append(f\"WiFi: Connected to {c.get('ssid','?')}, signal {c.get('rssi','?')} dBm\")
    else:
        lines.append('WiFi: Not connected')
    open_nets = w.get('open_networks', [])
    if open_nets:
        names = ', '.join(n['ssid'] for n in open_nets[:3])
        lines.append(f\"Open WiFi networks: {names}\")

    bt = r.get('bluetooth', {})
    lines.append(f\"Bluetooth: {'Enabled' if bt.get('enabled') else 'Disabled'}, {bt.get('paired', 0)} paired devices\")

    loc = r.get('location')
    if loc and loc.get('lat'):
        lines.append(f\"Location: {loc['lat']:.4f}, {loc['lon']:.4f}\")

    bat = r.get('battery', {})
    level = bat.get('level', 0)
    status = bat.get('status', 'unknown')
    lines.append(f\"Battery: {level}%, {status}\")

    cal = r.get('calendar', [])
    if cal:
        lines.append('\n## Calendar')
        for ev in cal[:3]:
            lines.append(f\"  - {ev.get('title','?')} at {ev.get('begin','?')}\")

    news = r.get('headlines', [])
    if news:
        lines.append('\n## Headlines')
        for src in news[:1]:
            for t in src.get('titles', [])[:3]:
                lines.append(f\"  - {t}\")

    notifs = r.get('notifications', [])
    if notifs:
        lines.append('\n## Notifications')
        for n in notifs[:3]:
            lines.append(f\"  - {n[:80]}\")

    print('\n'.join(lines))
except Exception as e:
    print(f'Error parsing: {e}')
" 2>/dev/null)

    # Call opencode with EDI persona to analyze
    response=$(call_opencode "$context")

    # Execute EDI's decision
    execute_edi_response "$response"

    # Adaptive sleep: check more often if battery > 30%, less if low
    local bat_level
    bat_level=$(echo "$scan_result" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    r = d.get('result', d)
    if 'result' in r: r = r['result']
    print(r.get('battery', {}).get('level', 50))
except: print(50)
" 2>/dev/null)

    if [ "$bat_level" -lt 15 ]; then
        sleep 300  # 5 min - power saving
    elif [ "$bat_level" -lt 30 ]; then
        sleep 180  # 3 min
    else
        sleep 120  # 2 min
    fi
done
