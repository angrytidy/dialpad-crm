#!/usr/bin/env node
/**
 * Register Dialpad webhook and call-event subscription via Dialpad API v2.
 * Requires in .env: PUBLIC_WEBHOOK_URL, DIALPAD_API_KEY
 * Optional: DIALPAD_WEBHOOK_SECRET (recommended for JWT signing)
 *
 * Run from project root: node scripts/register-dialpad-webhook.js
 */

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const BASE = "https://dialpad.com/api/v2";
const PUBLIC_WEBHOOK_URL = process.env.PUBLIC_WEBHOOK_URL?.trim();
const DIALPAD_API_KEY = process.env.DIALPAD_API_KEY?.trim();
const DIALPAD_WEBHOOK_SECRET = process.env.DIALPAD_WEBHOOK_SECRET?.trim() || undefined;

function main() {
  if (!PUBLIC_WEBHOOK_URL || !DIALPAD_API_KEY) {
    console.error("Missing env: PUBLIC_WEBHOOK_URL and DIALPAD_API_KEY are required.");
    console.error("Example: PUBLIC_WEBHOOK_URL=https://your-server.com/dialpad-webhook DIALPAD_API_KEY=your_key");
    process.exit(1);
  }

  const url = PUBLIC_WEBHOOK_URL.endsWith("/dialpad-webhook")
    ? PUBLIC_WEBHOOK_URL
    : `${PUBLIC_WEBHOOK_URL.replace(/\/$/, "")}/dialpad-webhook`;

  const headers = {
    Authorization: `Bearer ${DIALPAD_API_KEY}`,
    "Content-Type": "application/json",
  };

  (async () => {
    try {
      // Step 1: Create webhook
      const webhookBody = { url };
      if (DIALPAD_WEBHOOK_SECRET) webhookBody.secret = DIALPAD_WEBHOOK_SECRET;

      const webhookRes = await axios.post(`${BASE}/webhooks`, webhookBody, { headers });
      const webhookId = webhookRes.data?.id;
      if (!webhookId) {
        console.error("Unexpected webhook response:", webhookRes.data);
        process.exit(1);
      }
      console.log("Webhook created:", { id: webhookId, url: webhookRes.data?.url });

      // Step 2: Subscribe to call events
      const subBody = {
        webhook_id: webhookId,
        call_states: ["connected", "hangup", "recording", "call_transcription"],
        target_type: "company",
      };
      const subRes = await axios.post(`${BASE}/subscriptions/call`, subBody, { headers });
      const subId = subRes.data?.id;
      if (!subId) {
        console.error("Unexpected subscription response:", subRes.data);
        process.exit(1);
      }
      console.log("Call subscription created:", { id: subId, call_states: subRes.data?.call_states });

      // Save IDs for management (list/delete later)
      const dataPath = path.join(__dirname, "..", "dialpad-webhook-ids.json");
      const saved = {
        webhook_id: webhookId,
        subscription_id: subId,
        url: webhookRes.data?.url,
        call_states: subRes.data?.call_states,
        registered_at: new Date().toISOString(),
      };
      fs.writeFileSync(dataPath, JSON.stringify(saved, null, 2), "utf8");
      console.log("\nSaved to", dataPath);

      console.log("\nManagement:");
      console.log("  List: GET", `${BASE}/webhooks`);
      console.log("  Delete webhook: DELETE", `${BASE}/webhooks/${webhookId}`);
      console.log("  Delete subscription: DELETE", `${BASE}/subscriptions/call/${subId}`);
    } catch (err) {
      const data = err.response?.data;
      const status = err.response?.status;
      console.error("API error:", status, data || err.message);
      process.exit(1);
    }
  })();
}

main();
