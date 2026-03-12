#!/usr/bin/env node
/**
 * Register Dialpad webhook and call-event subscription via Dialpad API v2.
 * Requires in .env: DIALPAD_API_KEY (PUBLIC_WEBHOOK_URL optional if using hardcoded below)
 * Optional: DIALPAD_WEBHOOK_SECRET (recommended for JWT signing)
 *
 * Run from project root: node scripts/register-dialpad-webhook.js
 */

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const BASE = "https://dialpad.com/api/v2";
const REQUIRED_CALL_STATES = [
  "connected",
  "hangup",
  "recording",
  "call_transcription",
  "recap_summary",
  "recap_action_items",
];

// Hardcoded for testing when ngrok URL changes; .env PUBLIC_WEBHOOK_URL overrides this
const HARDCODED_WEBHOOK_URL = "https://965a-2a02-c207-2289-2239-00-1.ngrok-free.app";

const PUBLIC_WEBHOOK_URL =
  (process.env.PUBLIC_WEBHOOK_URL && process.env.PUBLIC_WEBHOOK_URL.trim()) || HARDCODED_WEBHOOK_URL;
const DIALPAD_API_KEY = process.env.DIALPAD_API_KEY && process.env.DIALPAD_API_KEY.trim();
const DIALPAD_WEBHOOK_SECRET = (process.env.DIALPAD_WEBHOOK_SECRET && process.env.DIALPAD_WEBHOOK_SECRET.trim()) || undefined;

function main() {
  if (!DIALPAD_API_KEY) {
    console.error("Missing env: DIALPAD_API_KEY is required.");
    console.error("Example: DIALPAD_API_KEY=your_key");
    process.exit(1);
  }
  if (!PUBLIC_WEBHOOK_URL) {
    console.error("Missing PUBLIC_WEBHOOK_URL (set in .env or edit HARDCODED_WEBHOOK_URL in this script).");
    process.exit(1);
  }
  console.log("Using webhook URL:", PUBLIC_WEBHOOK_URL);

  const url = PUBLIC_WEBHOOK_URL.endsWith("/dialpad-webhook")
    ? PUBLIC_WEBHOOK_URL
    : `${PUBLIC_WEBHOOK_URL.replace(/\/$/, "")}/dialpad-webhook`;

  const headers = {
    Authorization: `Bearer ${DIALPAD_API_KEY}`,
    "Content-Type": "application/json",
  };

  (async () => {
    try {
      // Step 1: Create webhook (Dialpad API expects hook_url)
      const webhookBody = { hook_url: url };
      if (DIALPAD_WEBHOOK_SECRET) webhookBody.secret = DIALPAD_WEBHOOK_SECRET;

      const webhookRes = await axios.post(`${BASE}/webhooks`, webhookBody, { headers });
      const webhookId = webhookRes.data && webhookRes.data.id;
      if (!webhookId) {
        console.error("Unexpected webhook response:", webhookRes.data);
        process.exit(1);
      }
      console.log("Webhook created:", { id: webhookId, url: webhookRes.data && webhookRes.data.url });

      // Step 2: List all existing call subscriptions and clean duplicates for this webhook_id
      const existingSubsRes = await axios.get(`${BASE}/subscriptions/call`, { headers });
      const existingSubs = (existingSubsRes.data && existingSubsRes.data.items) || existingSubsRes.data || [];
      const list = Array.isArray(existingSubs) ? existingSubs : [];

      console.log("Existing call subscriptions:");
      if (list.length === 0) {
        console.log("  (none)");
      } else {
        list.forEach(function (s) {
          var sid = s && s.id;
          var swid = s && (s.webhook_id || (s.webhook && s.webhook.id));
          var scalls = s && s.call_states;
          console.log(" ", { id: sid, webhook_id: swid, call_states: scalls });
        });
      }

      var deletedIds = [];
      for (var i = 0; i < list.length; i += 1) {
        var sub = list[i];
        var existingSubId = sub && sub.id;
        var subWebhookId = sub && (sub.webhook_id || (sub.webhook && sub.webhook.id));
        if (existingSubId && String(subWebhookId) === String(webhookId)) {
          await axios.delete(`${BASE}/subscriptions/call/${existingSubId}`, { headers });
          deletedIds.push(existingSubId);
        }
      }

      if (deletedIds.length > 0) {
        console.log("Deleted subscriptions:", deletedIds);
      } else {
        console.log("Deleted subscriptions: []");
      }

      // Step 3: Create one clean call subscription with AI recap states
      const subBody = {
        webhook_id: webhookId,
        call_states: REQUIRED_CALL_STATES,
      };
      const subRes = await axios.post(`${BASE}/subscriptions/call`, subBody, { headers });
      const subId = subRes.data && subRes.data.id;
      if (!subId) {
        console.error("Unexpected subscription response:", subRes.data);
        process.exit(1);
      }
      console.log("New call subscription created:", {
        id: subId,
        webhook_id: webhookId,
        call_states: subRes.data && subRes.data.call_states,
      });

      // Save IDs for management (list/delete later)
      const dataPath = path.join(__dirname, "..", "dialpad-webhook-ids.json");
      const saved = {
        webhook_id: webhookId,
        subscription_id: subId,
        url: webhookRes.data && webhookRes.data.url,
        call_states: subRes.data && subRes.data.call_states,
        registered_at: new Date().toISOString(),
      };
      fs.writeFileSync(dataPath, JSON.stringify(saved, null, 2), "utf8");
      console.log("\nSaved to", dataPath);

      console.log("\nManagement:");
      console.log("  List: GET", `${BASE}/webhooks`);
      console.log("  Delete webhook: DELETE", `${BASE}/webhooks/${webhookId}`);
      console.log("  Delete subscription: DELETE", `${BASE}/subscriptions/call/${subId}`);
    } catch (err) {
      const data = err.response && err.response.data;
      const status = err.response && err.response.status;
      console.error("API error:", status, data || err.message);
      process.exit(1);
    }
  })();
}

main();
