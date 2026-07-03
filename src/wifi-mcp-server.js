#!/usr/bin/env node
import { execSync } from "child_process";
import { createServer } from "http";

function termuxJson(cmd) {
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout: 10000 });
    return JSON.parse(out);
  } catch (e) {
    return { error: e.stderr?.trim() || e.message };
  }
}

const TOOLS = {
  get_connection_info: {
    description: "Get current WiFi connection details: SSID, BSSID, IP, link speed, frequency, signal strength, security",
    handler: async () => {
      const info = termuxJson("termux-wifi-connectioninfo");
      return info;
    }
  },
  scan_networks: {
    description: "Scan for nearby WiFi networks. Returns list with SSID, BSSID, signal strength (RSSI), channel, frequency, capabilities",
    handler: async () => {
      const scan = termuxJson("termux-wifi-scaninfo");
      return scan;
    }
  },
  toggle_wifi: {
    description: "Enable or disable WiFi",
    params: { action: { type: "string", enum: ["on", "off"] } },
    handler: async ({ action }) => {
      const r = termuxJson(`termux-wifi-enable ${action === "on"}`);
      return r;
    }
  },
  get_signal_strength: {
    description: "Get current WiFi signal strength indicator (RSSI in dBm)",
    handler: async () => {
      const info = termuxJson("termux-wifi-connectioninfo");
      if (info?.error) return info;
      const rssi = info.rssi ?? info.signal_strength ?? null;
      const quality = rssi !== null ? Math.min(100, Math.max(0, 2 * (rssi + 100))) : null;
      return { rssi_dbm: rssi, quality_percent: quality, ...info };
    }
  },
  get_wifi_info_formatted: {
    description: "Get a human-readable summary of the current WiFi connection",
    handler: async () => {
      const info = termuxJson("termux-wifi-connectioninfo");
      if (info?.error) return info;
      const ssid = info.ssid || "N/A";
      const bssid = info.bssid || "N/A";
      const ip = info.ip || info.ip_address || "N/A";
      const freq = info.frequency_mhz || info.frequency || "N/A";
      const speed = info.link_speed_mbps || info.linkSpeed || "N/A";
      const rssi = info.rssi ?? info.signal_strength ?? null;
      const quality = rssi !== null ? Math.min(100, Math.max(0, 2 * (rssi + 100))) : null;
      return {
        summary: `Connected to "${ssid}" (${bssid}) at ${freq} MHz, ${speed} Mbps, signal ${quality}%`,
        ssid, bssid, ip, frequency: freq, link_speed: speed, signal_quality: quality, raw: info
      };
    }
  },
  connect_to_network: {
    description: "Connect to a WiFi network. Tries Shizuku first, then ADB, then opens WiFi settings as fallback.",
    params: {
      ssid: { type: "string", description: "Network SSID to connect to" },
      password: { type: "string", description: "Network password", optional: true },
      security: { type: "string", enum: ["open", "wpa2", "wpa3", "wep"], description: "Security type (default: wpa2 if password given, open if not)", optional: true }
    },
    handler: async ({ ssid, password, security }) => {
      const esc = s => s.replace(/"/g, '\\"');
      const secType = security || (password ? "wpa2" : "open");
      const rishPath = ["/data/data/com.termux/files/home/bin/rish", "/data/data/com.termux/files/usr/bin/rish", "rish"].find(p => { try { execSync(`test -x ${p.startsWith("/") ? p : `"$(command -v ${p})"`}`, { encoding: "utf8", timeout: 2000 }); return true; } catch { return false; } });
      if (rishPath) {
        try {
          const cmd = `${rishPath} -c 'cmd wifi connect-network "${esc(ssid)}" ${secType}${password ? ` "${esc(password)}"` : ""}'`;
          const out = execSync(cmd, { encoding: "utf8", timeout: 20000 });
          return { method: "shizuku", result: out.trim() || "Connected via Shizuku" };
        } catch (e) { return { method: "shizuku", error: e.message, fallback: true }; }
      }
      try {
        execSync('cmd wifi', { encoding: "utf8", timeout: 3000 });
        const pwArg = password ? `wpa2 "${password}"` : "open";
        const out = execSync(`cmd wifi connect-network "${ssid}" ${pwArg}`, { encoding: "utf8", timeout: 15000 });
        return { method: "adb", result: out.trim() || "Connected via cmd wifi" };
      } catch {}
      execSync("am start -a android.settings.WIFI_SETTINGS", { timeout: 3000 });
      return {
        method: "fallback",
        note: `Opened WiFi settings. Find "${ssid}" and tap to connect.`,
        tip: "Install Shizuku for automatic WiFi connections."
      };
    }
  },
  open_wifi_settings: {
    description: "Open the WiFi settings page on the phone",
    handler: async () => {
      execSync("am start -a android.settings.WIFI_SETTINGS", { timeout: 3000 });
      return { result: "WiFi settings opened" };
    }
  }
};

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.method === "GET" && req.url === "/") {
    return res.end(JSON.stringify({ name: "wifi-mcp-server", tools: Object.keys(TOOLS) }));
  }

  if (req.method === "POST" && req.url === "/mcp") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { tool, params } = JSON.parse(body);
      const fn = Object.entries(TOOLS).find(([k]) => k === tool);
      if (!fn) return res.end(JSON.stringify({ error: `Unknown tool: ${tool}` }));
      const result = await fn[1].handler(params || {});
      return res.end(JSON.stringify({ result }));
    } catch (e) {
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

const PORT = process.env.PORT || 3101;
server.listen(PORT, "127.0.0.1", () => {
  console.error(`WiFi MCP server on http://127.0.0.1:${PORT}/mcp`);
});
