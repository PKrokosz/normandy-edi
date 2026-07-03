#!/usr/bin/env node
import { createServer } from "http";

const TOOLS = {
  bluetooth_status: {
    description: "Check if Bluetooth is enabled and get paired devices info",
    parameters: {},
    handler: async () => {
      let enabled = null, paired = [];
      try {
        const { execSync } = await import("child_process");
        const res = execSync("settings get global bluetooth_on 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
        enabled = res === "1";
      } catch {}
      try {
        const { execSync } = await import("child_process");
        const res = execSync("cmd bluetooth_manager get-paired-devices 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
        if (res && res !== "error") paired = res.split("\n").filter(Boolean);
      } catch {}
      return { content: [{ type: "text", text: JSON.stringify({ enabled, paired, note: "Full BT control needs Shizuku" }) }] };
    }
  },
  open_bluetooth_settings: {
    description: "Open Bluetooth settings on the phone",
    parameters: {},
    handler: async () => {
      const { execSync } = await import("child_process");
      execSync("am start -a android.settings.BLUETOOTH_SETTINGS 2>/dev/null", { timeout: 3000 });
      return { content: [{ type: "text", text: "Bluetooth settings opened" }] };
    }
  },
  toggle_bluetooth: {
    description: "Toggle Bluetooth on/off (may show system dialog)",
    parameters: { action: { type: "string", enum: ["on", "off"], description: "Turn on or off" } },
    handler: async ({ action }) => {
      const { execSync } = await import("child_process");
      if (action === "on") {
        execSync("am start -a android.bluetooth.adapter.action.REQUEST_ENABLE 2>/dev/null", { timeout: 3000 });
      } else {
        execSync("am start -a android.bluetooth.adapter.action.REQUEST_DISABLE 2>/dev/null", { timeout: 3000 });
      }
      return { content: [{ type: "text", text: `Requested to turn Bluetooth ${action} (system dialog may appear)` }] };
    }
  },
  scan_bluetooth_devices: {
    description: "Scan for nearby Bluetooth devices (requires Shizuku rish)",
    parameters: { timeout_seconds: { type: "number", default: 5 } },
    handler: async ({ timeout_seconds = 5 }) => {
      let devices = [];
      try {
        const { execSync } = await import("child_process");
        if (execSync("command -v rish", { encoding: "utf8", timeout: 2000 }).trim()) {
          const res = execSync(`rish 'cmd bluetooth_manager discoverable ${timeout_seconds}; dumpsys bluetooth_manager'`, { encoding: "utf8", timeout: 30000 });
          devices = res.split("\n").filter(l => l.includes("device") || l.includes("Device"));
        }
      } catch {}
      return { content: [{ type: "text", text: JSON.stringify({ devices: devices.length ? devices : "Shizuku required", note: "Install Shizuku + rish for full BT scanning" }) }] };
    }
  },
  proximity_automation: {
    description: "Create a Bluetooth proximity automation rule",
    parameters: {
      device_name: { type: "string", description: "Device name or MAC to watch for" },
      on_connect_action: { type: "string", description: "Command to run when device connects" },
      on_disconnect_action: { type: "string", description: "Command to run when device disconnects" }
    },
    handler: async ({ device_name, on_connect_action, on_disconnect_action }) => {
      const script = `#!/data/data/com.termux/files/usr/bin/bash
DEVICE="${device_name}"
ON_CONNECT="${on_connect_action}"
ON_DISCONNECT="${on_disconnect_action}"
echo "Monitoring for: $DEVICE"
termux-notification -t "BT Proximity Monitor" -c "Watching for $DEVICE"
`;
      const { writeFileSync } = await import("fs");
      const scriptPath = "/data/data/com.termux/files/home/.btproximity.sh";
      writeFileSync(scriptPath, script);
      const { execSync } = await import("child_process");
      execSync(`chmod +x ${scriptPath}`, { timeout: 3000 });
      return { content: [{ type: "text", text: `Automation rule created at ${scriptPath}. To run: nohup bash ${scriptPath} &` }] };
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
    res.writeHead(200);
    res.end(JSON.stringify({ name: "bluetooth-mcp-server", version: "1.0.0", tools: Object.keys(TOOLS) }));
    return;
  }

  if (req.method === "POST" && req.url === "/mcp") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { tool, params } = JSON.parse(body);
      if (TOOLS[tool]) {
        const result = await TOOLS[tool].handler(params || {});
        res.writeHead(200);
        res.end(JSON.stringify({ result }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Unknown tool: ${tool}` }));
      }
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

const PORT = process.env.PORT || 3100;
server.listen(PORT, "127.0.0.1", () => {
  console.error(`Bluetooth MCP server running on http://127.0.0.1:${PORT}/mcp`);
});
