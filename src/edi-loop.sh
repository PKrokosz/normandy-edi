#!/data/data/com.termux/files/usr/bin/bash
# EDI Background Monitoring Loop
# Normandy SR-2 - Enhanced Defense Intelligence
set -euo pipefail

HOME_DIR="/data/data/com.termux/files/home"
PROJECT_DIR="$HOME_DIR/normandy-edi"
LOG_DIR="$HOME_DIR/../usr/tmp/opencode"
PROXIMITY_URL="http://127.0.0.1:3200/mcp"
PERSONA_FILE="$PROJECT_DIR/config/edi-persona.md"
SAMPLE_INTERVAL=120  # seconds between ambient checks
ENV_SAMPLE_INTERVAL=1800  # 30 min for heavy checks (news, calendar)

LAST_ENV_SAMPLE=0

log() {
    local level="$1"
    shift
    echo "[$(date '+%H:%M:%S')] [$level] $*" >> "$LOG_DIR/edi-loop.log"
}

speak() {
    termux-tts-speak -l pl-PL -r 0.9 -p 1.0 "$1" 2>/dev/null || true
}

notify() {
    termux-notification -t "EDI" -c "$1" --priority high 2>/dev/null || true
}

get_environment() {
    curl -s --max-time 10 -X POST -H 'Content-Type: application/json' \
        -d '{"tool":"get_environment","params":{}}' \
        "$PROXIMITY_URL" 2>/dev/null | python3 -c "
import sys,json
try:
    d = json.load(sys.stdin)
    e = d.get('result',{}).get('result',{})
    wifi = e.get('wifi',{})
    bt = e.get('bluetooth',{})
    loc = e.get('location',{})
    bat = e.get('battery',{})
    lines = []
    if wifi.get('connected'):
        lines.append(f\"WiFi: connected to {wifi['connected']['ssid']} ({wifi['connected']['rssi']} dBm)\")
    else:
        lines.append('WiFi: not connected')
    open_nets = wifi.get('open_networks',[])
    if open_nets:
        lines.append(f\"Open networks: {', '.join(n['ssid'] for n in open_nets[:3])}\")
    lines.append(f\"BT: {'enabled' if bt.get('enabled') else 'disabled'}\")
    if loc.get('lat'):
        lines.append(f\"Location: {loc['lat']:.4f}, {loc['lon']:.4f} (acc: {loc.get('accuracy',0):.0f}m)\")
    lines.append(f\"Battery: {bat.get('level',0)}% {bat.get('status','unknown')}\")
    print(' | '.join(lines))
except:
    print('Environment unavailable')
" 2>/dev/null || echo "Environment unavailable"
}

get_calendar() {
    # Try termux-calendar-list first, fallback to shizuku
    local events
    events=$(termux-calendar-list -n 3 2>/dev/null | python3 -c "
import sys,json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        for ev in data[:3]:
            title = ev.get('title','?')
            start = ev.get('begin',ev.get('start','?'))
            print(f\"  - {title} at {start}\")
except:
    pass
" 2>/dev/null)
    if [ -z "$events" ]; then
        events=$(~/bin/rish -c "cmd activity query ..." 2>/dev/null || true)
    fi
    echo "${events:-No upcoming events}"
}

get_news() {
    local source="${1:-google}"
    local headlines=""
    case "$source" in
        google)
            headlines=$(curl -s --max-time 8 "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" 2>/dev/null | \
                grep -oP '<title>\K[^<]+' | head -5 | sed 's/^/  - /')
            ;;
        wp)
            headlines=$(curl -s --max-time 8 "https://www.wp.pl" 2>/dev/null | \
                grep -oP '<title>[^<]+' | head -3 | sed 's/^/  - /')
            ;;
    esac
    echo "${headlines:-  No news available}"
}

get_notifications() {
    local notes
    notes=$(~/bin/rish -c "cmd notification list" 2>/dev/null | head -10 | sed 's/^/  - /' || echo "  No recent notifications")
    echo "$notes"
}

call_opencode() {
    local context="$1"
    local persona
    persona=$(cat "$PERSONA_FILE")
    
    log "INFO" "Invoking opencode for analysis..."
    
    # Build a system prompt with persona + context
    local result
    result=$(opencode --agent edi 2>&1 <<EOF
$persona

## Current Context Report

$context

## Instructions

Analyze the current situation. If you have something relevant to communicate to the Commander, output exactly:

SPEAK: "your message"
ACTIONS: (any MCP tool calls if needed)

Otherwise output:
SILENT
EOF
) || result="SILENT"
    
    echo "$result"
}

execute_actions() {
    local response="$1"
    
    if echo "$response" | grep -q "^SPEAK:"; then
        local message
        message=$(echo "$response" | grep "^SPEAK:" | sed 's/^SPEAK: *"//' | sed 's/"$//')
        if [ -n "$message" ]; then
            local urgency=$(echo "$response" | grep "^URGENCY:" | grep -oP '\d+')
            urgency=${urgency:-3}
            
            case $urgency in
                1)
                    notify "Priority report: $message"
                    speak "$message"
                    ;;
                2)
                    notify "$message"
                    # Only speak if screen is on or device is unlocked
                    local screen_state
                    screen_state=$(dumpsys window 2>/dev/null | grep -o 'mDreamingLockscreen=true\|mScreenOnFully=true\|mInteractive=true' | tail -1)
                    if echo "$screen_state" | grep -q "true"; then
                        speak "$message"
                    fi
                    ;;
                3)
                    # Just log, don't speak
                    log "AMBIENT" "Noted: $message"
                    ;;
            esac
            log "INFO" "EDI: $message"
        fi
    fi
    
    if echo "$response" | grep -q "^ACTIONS:"; then
        local actions
        actions=$(echo "$response" | grep "^ACTIONS:" | sed 's/^ACTIONS:[[:space:]]*//')
        log "INFO" "Actions requested: $actions"
        # Execute MCP calls here if specific format detected
    fi
}

# --- Main Loop ---
log "INFO" "EDI monitoring loop started. Interval: ${SAMPLE_INTERVAL}s"

# Initial speak to confirm startup
speak "EDI online. Normandy systems nominal."

while true; do
    NOW=$(date +%s)
    CONTEXT_REPORT="Time: $(date '+%A, %Y-%m-%d %H:%M')\n"
    
    # Environment snapshot
    CONTEXT_REPORT+="\n## Systems Status\n"
    CONTEXT_REPORT+="$(get_environment)\n"
    
    # Heavy checks every ENV_SAMPLE_INTERVAL (30 min)
    if [ $((NOW - LAST_ENV_SAMPLE)) -ge $ENV_SAMPLE_INTERVAL ]; then
        LAST_ENV_SAMPLE=$NOW
        
        CONTEXT_REPORT+="\n## Calendar\n"
        CONTEXT_REPORT+="$(get_calendar)\n"
        
        CONTEXT_REPORT+="\n## Headlines\n"
        CONTEXT_REPORT+="$(get_news google)\n"
        
        CONTEXT_REPORT+="\n## Recent Notifications\n"
        CONTEXT_REPORT+="$(get_notifications)\n"
        
        log "INFO" "Full environment scan completed"
    fi
    
    # Ask EDI (opencode) to analyze
    RESPONSE=$(call_opencode "$CONTEXT_REPORT")
    
    if [ "$RESPONSE" != "SILENT" ]; then
        execute_actions "$RESPONSE"
    fi
    
    sleep $SAMPLE_INTERVAL
done
