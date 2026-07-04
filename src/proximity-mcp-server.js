#!/usr/bin/env node
import { execSync } from "child_process";
import { createServer } from "http";

const HOME = process.env.HOME || "/data/data/com.termux/files/home";
const RISH = ["/data/data/com.termux/files/home/bin/rish", "/data/data/com.termux/files/usr/bin/rish"].find(p => { try { return execSync(`test -x ${p}`, { encoding: "utf8", timeout: 2000 }), true; } catch { return false; } });

function termuxJson(cmd, timeout = 8000) {
  try { return JSON.parse(execSync(cmd, { encoding: "utf8", timeout })); } catch { return null; }
}

function shizuku(cmd) {
  if (!RISH) return null;
  try {
    const out = execSync(`${RISH} -c '${cmd.replace(/'/g, "'\\''")}'`, { encoding: "utf8", timeout: 10000 }).trim();
    if (out.startsWith("Unknown") || out.startsWith("Error") || out.includes("exception")) return null;
    return out;
  } catch { return null; }
}

function speak(text) {
  try { execSync(`termux-tts-speak -l pl-PL -r 0.9 -p 1.0 ${JSON.stringify(text)}`, { encoding: "utf8", timeout: 10000 }); } catch {}
}

function notify(title, text) {
  try { execSync(`termux-notification -t ${JSON.stringify(title)} -c ${JSON.stringify(text)} --priority high`, { encoding: "utf8", timeout: 3000 }); } catch {}
}

function playSound(file) {
  try { execSync(`termux-media-player play ${JSON.stringify(file)} 2>/dev/null`, { encoding: "utf8", timeout: 5000 }); } catch {}
}

let triggers = [];
let state = {
  wifi: { connected: null, visible: [] },
  bt: { enabled: false, paired: [] },
  location: null,
  battery: null,
  calendar: [],
  last_news: [],
  notifications: []
};
let monitorInterval = null;
let heavyScanCounter = 0;

function scanWifi() {
  const conn = termuxJson("termux-wifi-connectioninfo", 5000);
  const scan = termuxJson("termux-wifi-scaninfo", 8000);
  if (conn && !conn.error) state.wifi.connected = conn;
  if (Array.isArray(scan)) {
    state.wifi.visible = scan.map(n => ({
      ssid: n.ssid || "(hidden)", bssid: n.bssid, rssi: n.rssi,
      freq: n.frequency_mhz, open: !n.capabilities || n.capabilities === "[ESS]" || !n.capabilities.includes("WPA"),
      capabilities: n.capabilities || ""
    }));
  }
}

function checkBt() {
  try {
    const s = execSync("settings get global bluetooth_on 2>/dev/null", { timeout: 2000, encoding: "utf8" }).trim();
    state.bt.enabled = s === "1";
  } catch { state.bt.enabled = false; }
  state.bt.paired = [];
  if (RISH) {
    try {
      const res = shizuku("dumpsys bluetooth_manager | grep -i 'name:' | head -5");
      if (res) state.bt.paired = res.split("\n").filter(Boolean);
    } catch {}
  }
}

function checkLocation() {
  const loc = termuxJson("termux-location -p network", 8000);
  if (loc && !loc.error) state.location = loc;
}

function checkBattery() {
  const bat = termuxJson("termux-battery-status", 3000);
  if (bat && !bat.error) state.battery = bat;
}

function checkCalendar() {
  try {
    const raw = execSync("termux-calendar-list -n 5 2>/dev/null", { encoding: "utf8", timeout: 8000 }).trim();
    if (!raw || raw === "[]" || raw.startsWith("Usage") || raw.startsWith("Error")) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      state.calendar = parsed.map(e => ({
        title: e.title || "(no title)",
        begin: e.begin || e.start || "?",
        end: e.end || "?",
        location: e.eventLocation || e.location || "",
        allDay: e.allDay || false
      }));
    }
  } catch { state.calendar = []; }
}

function checkNews() {
  const sources = [
    { url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", label: "Google News" },
    { url: "https://news.google.com/rss?hl=pl&gl=PL&ceid=PL:pl", label: "Google News PL" }
  ];
  const headlines = [];
  for (const src of sources) {
    try {
      const body = execSync(`curl -s --max-time 6 ${JSON.stringify(src.url)}`, { encoding: "utf8", timeout: 10000 });
      const titles = [];
      const regex = /<title>([^<]+)<\/title>/g;
      let m;
      while ((m = regex.exec(body)) !== null) {
        if (m[1] !== "Google News" && m[1] !== "Google News" && !m[1].startsWith("Google News")) {
          titles.push(m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
        }
        if (titles.length >= 5) break;
      }
      if (titles.length) {
        headlines.push({ source: src.label, titles });
        break;
      }
    } catch {}
  }
  if (headlines.length) state.last_news = headlines;
}

function checkNotifications() {
  try {
    const res = shizuku("cmd notification list");
    if (res) {
      state.notifications = res.split("\n")
        .filter(l => l.includes("NotificationRecord") || l.includes("key="))
        .slice(0, 20)
        .map(l => l.trim());
    }
  } catch {}
}

function getEnvironmentSnapshot() {
  return {
    wifi: {
      connected: state.wifi.connected ? { ssid: state.wifi.connected.ssid, rssi: state.wifi.connected.rssi, ip: state.wifi.connected.ip } : null,
      visible: state.wifi.visible.length,
      open_networks: state.wifi.visible.filter(n => n.open && n.ssid !== "(hidden)").map(n => ({ ssid: n.ssid, rssi: n.rssi, freq: n.freq })),
      scan_time: new Date().toISOString()
    },
    bluetooth: { enabled: state.bt.enabled, paired: state.bt.paired.length },
    location: state.location ? { lat: state.location.latitude, lon: state.location.longitude, accuracy: state.location.accuracy } : null,
    battery: state.battery ? { level: state.battery.percentage, status: state.battery.status, temp: state.battery.temperature } : null,
    calendar: state.calendar.slice(0, 3),
    headlines: state.last_news,
    notifications: state.notifications.slice(0, 5)
  };
}

function getOpenNetworks() {
  return state.wifi.visible.filter(n => n.open && n.ssid && n.ssid !== "(hidden)");
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function interpolate(msg, ctx) {
  return msg.replace(/{(\w+)}/g, (_, k) => {
    if (k === "ssid") return ctx.ssid || ctx.network?.ssid || ctx.strongest?.ssid || "?";
    if (k === "rssi") return ctx.strongest?.rssi ?? ctx.network?.rssi ?? "?";
    if (k === "count") return ctx.count ?? "?";
    if (k === "level") return ctx.level ?? "?";
    if (k === "zone") return ctx.zone || "?";
    if (k === "device") return ctx.device || "?";
    if (k === "distance") return ctx.distance_km?.toFixed(2) ?? "?";
    if (k === "bssid") return ctx.network?.bssid || ctx.strongest?.bssid || "?";
    if (k === "title") return ctx.event?.title || "?";
    if (k === "time") return ctx.event?.begin || "?";
    if (k === "headline") return ctx.headline || "?";
    return k;
  });
}

function evaluateTriggers() {
  const openNets = getOpenNetworks();
  const currentSsid = state.wifi.connected?.ssid;
  const batLevel = state.battery?.percentage ?? -1;
  const isCharging = state.battery?.status === "CHARGING";
  const now = Date.now();

  for (const t of triggers) {
    if (t.lastFired && now - t.lastFired < (t.cooldown || 60000)) continue;
    let fire = false; let ctx = {};

    switch (t.event) {
      case "open_wifi_seen": {
        const match = openNets.filter(n => {
          if (t.params?.min_rssi && n.rssi < t.params.min_rssi) return false;
          if (t.params?.ssid_pattern && !n.ssid.includes(t.params.ssid_pattern)) return false;
          return true;
        });
        if (match.length > 0) { fire = true; ctx = { networks: match, count: match.length, strongest: match.sort((a,b) => b.rssi - a.rssi)[0] }; }
        break;
      }
      case "specific_wifi_seen": {
        const m = state.wifi.visible.find(n => n.ssid === t.params.ssid || n.bssid === t.params.bssid);
        if (m) { fire = true; ctx = { network: m }; }
        break;
      }
      case "specific_wifi_lost": {
        const wasSeen = t._lastSeen?.ssid === t.params.ssid;
        const nowSeen = state.wifi.visible.some(n => n.ssid === t.params.ssid || n.bssid === t.params.bssid);
        if (wasSeen && !nowSeen) { fire = true; ctx = { network: t._lastSeen }; }
        t._lastSeen = nowSeen ? state.wifi.visible.find(n => n.ssid === t.params.ssid || n.bssid === t.params.bssid) : null;
        break;
      }
      case "wifi_connected": {
        if (currentSsid === t.params?.ssid) { fire = true; ctx = { ssid: currentSsid }; }
        break;
      }
      case "wifi_disconnected": {
        if (!currentSsid && t._wasConnected) { fire = true; ctx = { last_ssid: t._lastSsid }; }
        t._wasConnected = !!currentSsid;
        t._lastSsid = currentSsid;
        break;
      }
      case "bt_device_seen": {
        const d = state.bt.paired.find(p => p.includes(t.params?.device_name || ""));
        if (d) { fire = true; ctx = { device: d }; }
        break;
      }
      case "geo_enter": {
        if (state.location) {
          const dist = haversine(state.location.latitude, state.location.longitude, t.params.lat, t.params.lon);
          if (dist < (t.params.radius_km || 0.5) && !t._inside) { fire = true; ctx = { zone: t.params.name || "zone", distance_km: dist }; }
          t._inside = dist < (t.params.radius_km || 0.5);
        }
        break;
      }
      case "geo_exit": {
        if (state.location) {
          const dist = haversine(state.location.latitude, state.location.longitude, t.params.lat, t.params.lon);
          if (dist >= (t.params.radius_km || 0.5) && t._inside) { fire = true; ctx = { zone: t.params.name || "zone", distance_km: dist }; }
          t._inside = dist < (t.params.radius_km || 0.5);
        }
        break;
      }
      case "battery_low": {
        if (batLevel >= 0 && batLevel <= (t.params?.threshold || 20) && !isCharging && !t._wasLow) { fire = true; ctx = { level: batLevel }; }
        t._wasLow = batLevel <= (t.params?.threshold || 20) && !isCharging;
        break;
      }
      case "battery_charging": {
        if (isCharging && !t._wasCharging) { fire = true; ctx = { status: "charging" }; }
        if (!isCharging && t._wasCharging) { fire = true; ctx = { status: "disconnected" }; }
        t._wasCharging = isCharging;
        break;
      }
      case "calendar_event": {
        for (const ev of state.calendar) {
          if (ev.begin && !ev._notified) {
            const eventTime = new Date(ev.begin).getTime();
            const leadMinutes = t.params?.lead_minutes || 30;
            if (now >= eventTime - leadMinutes * 60000 && now < eventTime + 60000) {
              fire = true; ctx = { event: ev };
              ev._notified = true;
              break;
            }
          }
        }
        break;
      }
    }

    if (fire) {
      t.lastFired = now;
      const msg = interpolate(t.action?.message || "", ctx);
      const actionType = t.action?.type || "tts";

      if (t.action?.sound_first) {
        const soundFile = t.action.soundFile || `${HOME}/.config/opencode/sounds/intercom.wav`;
        playSound(soundFile);
      }

      switch (actionType) {
        case "tts": speak(msg); break;
        case "notify": notify(t.action?.title || "EDI", msg); break;
        case "toast": execSync(`termux-toast ${JSON.stringify(msg)}`, { timeout: 3000 }); break;
        case "both": speak(msg); notify(t.action?.title || "EDI", msg); break;
        case "chime": {
          const soundFile = t.action.soundFile || `${HOME}/.config/opencode/sounds/intercom.wav`;
          playSound(soundFile);
          notify(t.action?.title || "EDI", msg);
          break;
        }
      }
    }
  }
}

function startMonitor() {
  scanWifi(); checkBt(); checkLocation(); checkBattery();
  checkCalendar();
  monitorInterval = setInterval(() => {
    scanWifi(); checkBt();
    if (triggers.some(t => t.event.startsWith("geo_"))) checkLocation();
    if (triggers.some(t => t.event.startsWith("battery_"))) checkBattery();
    if (triggers.some(t => t.event === "calendar_event")) checkCalendar();
    heavyScanCounter++;
    if (heavyScanCounter % 12 === 0) { // every ~3 minutes
      checkCalendar();
    }
    if (heavyScanCounter % 30 === 0) { // every ~7.5 minutes
      checkNews();
    }
    evaluateTriggers();
  }, 15000);
}

const TOOLS = {
  add_trigger: {
    description: "Create a context-aware trigger that monitors WiFi/BT/GPS/battery/calendar and speaks/acts",
    params: {
      id: { type: "string", description: "Unique name for this trigger" },
      event: {
        type: "string",
        enum: ["open_wifi_seen", "specific_wifi_seen", "specific_wifi_lost", "wifi_connected", "wifi_disconnected", "bt_device_seen", "geo_enter", "geo_exit", "battery_low", "battery_charging", "calendar_event"],
        description: "What event to watch for"
      },
      params: {
        type: "object",
        description: "Event parameters (ssid, bssid, lat, lon, radius_km, threshold, min_rssi, name, device_name, lead_minutes)",
        optional: true
      },
      action: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["tts", "notify", "toast", "both", "chime"], default: "notify" },
          title: { type: "string", description: "Notification title", optional: true },
          message: { type: "string", description: "Message with {ssid} {rssi} {count} {level} {zone} {device} {title} {time}" },
          sound_first: { type: "boolean", default: false, description: "Play sound before message" },
          soundFile: { type: "string", description: "Custom sound file path", optional: true }
        }
      },
      cooldown: { type: "number", description: "Min seconds between fires (default 120)", optional: true }
    },
    handler: async ({ id, event, params = {}, action, cooldown = 120 }) => {
      const existing = triggers.findIndex(t => t.id === id);
      const trigger = { id, event, params, action, cooldown: cooldown * 1000, lastFired: 0 };
      if (existing >= 0) triggers[existing] = trigger;
      else triggers.push(trigger);
      if (!monitorInterval) startMonitor();
      return { result: `Trigger "${id}" created for event "${event}". Monitoring active.` };
    }
  },
  remove_trigger: {
    description: "Remove a trigger by ID",
    params: { id: { type: "string" } },
    handler: async ({ id }) => {
      triggers = triggers.filter(t => t.id !== id);
      if (triggers.length === 0 && monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
      return { result: `Trigger "${id}" removed` };
    }
  },
  list_triggers: {
    description: "List all active triggers with their status",
    handler: async () => ({
      result: triggers.map(t => ({
        id: t.id, event: t.event, params: t.params,
        action: t.action, lastFired: t.lastFired ? new Date(t.lastFired).toISOString() : null,
        cooldown_s: t.cooldown / 1000
      }))
    })
  },
  get_environment: {
    description: "Get current environment snapshot: WiFi, BT, location, battery",
    handler: async () => {
      scanWifi(); checkBt(); checkLocation(); checkBattery();
      return { result: getEnvironmentSnapshot() };
    }
  },
  complete_scan: {
    description: "Full scan: WiFi, BT, location, battery, calendar, headlines, notifications",
    handler: async () => {
      scanWifi(); checkBt(); checkLocation(); checkBattery();
      checkCalendar(); checkNews(); checkNotifications();
      return { result: getEnvironmentSnapshot() };
    }
  },
  check_calendar: {
    description: "Get upcoming calendar events",
    handler: async () => {
      checkCalendar();
      return { result: { calendar: state.calendar.slice(0, 5) } };
    }
  },
  check_news: {
    description: "Fetch latest news headlines",
    handler: async () => {
      checkNews();
      return { result: { headlines: state.last_news } };
    }
  },
  check_notifications: {
    description: "Get recent phone notifications",
    handler: async () => {
      checkNotifications();
      return { result: { notifications: state.notifications.slice(0, 10) } };
    }
  },
  trigger_now: {
    description: "Manually fire a trigger by ID with optional override message",
    params: { id: { type: "string" }, override_message: { type: "string", optional: true } },
    handler: async ({ id, override_message }) => {
      const t = triggers.find(t => t.id === id);
      if (!t) return { error: `Trigger "${id}" not found` };
      scanWifi(); checkBt(); checkLocation(); checkBattery();
      t.lastFired = 0;
      const msg = override_message || t.action?.message || "Trigger fired";
      if (t.action?.sound_first) {
        const sf = t.action.soundFile || `${HOME}/.config/opencode/sounds/intercom.wav`;
        playSound(sf);
      }
      speak(msg);
      return { result: `Trigger "${id}" fired: "${msg}"` };
    }
  },
  speak: {
    description: "Make the phone speak any text through the speaker",
    params: { text: { type: "string" } },
    handler: async ({ text }) => { speak(text); return { result: "Speaking..." }; }
  },
  play_chime: {
    description: "Play the Normandy intercom chime sound",
    handler: async () => {
      const sf = `${HOME}/.config/opencode/sounds/intercom.wav`;
      playSound(sf);
      return { result: "Chime played" };
    }
  }
};

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  if (req.method === "GET" && req.url === "/") return res.end(JSON.stringify({ name: "proximity-mcp", tools: Object.keys(TOOLS) }));
  if (req.method === "POST" && req.url === "/mcp") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { tool, params } = JSON.parse(body);
      const fn = Object.entries(TOOLS).find(([k]) => k === tool);
      if (!fn) return res.end(JSON.stringify({ error: `Unknown: ${tool}` }));
      const result = await fn[1].handler(params || {});
      return res.end(JSON.stringify({ result }));
    } catch (e) { return res.end(JSON.stringify({ error: e.message })); }
  }
  res.writeHead(404); res.end(JSON.stringify({ error: "Not found" }));
});

const PORT = process.env.PORT || 3200;
server.listen(PORT, "127.0.0.1", () => {
  console.error(`Proximity MCP on http://127.0.0.1:${PORT}/mcp`);
  console.error(`Tools: ${Object.keys(TOOLS).join(", ")}`);
});
