require("dotenv").config();

const express = require("express");
const axios = require("axios");
const axiosRetry = require("axios-retry");
const fs = require("fs");
const path = require("path");
const winston = require("winston");
const jwt = require("jsonwebtoken");
const { parsePhoneNumberWithError } = require("libphonenumber-js");

const app = express();
// Capture raw body for /dialpad-webhook so we can verify JWT when DIALPAD_WEBHOOK_SECRET is set
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.url === "/dialpad-webhook" && buf?.length) req.rawBody = buf;
    },
  })
);

const CRM_API_KEY = process.env.CRM_API_KEY;
const CRM_USER_CODE = process.env.CRM_USER_CODE;
const CRM_ASSIGNED_TO = process.env.CRM_ASSIGNED_TO; // Required for CreateContact: LAC User ID
const PORT = process.env.PORT || 3000;
const CRM_URL = "https://api.lessannoyingcrm.com";
const DIALPAD_WEBHOOK_SECRET = process.env.DIALPAD_WEBHOOK_SECRET || null;

// --- Logging ---
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "dialpad-crm-webhook" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ filename: path.join(logsDir, "webhook.log") }),
  ],
});

// --- Phone normalization (E.164) ---
const DEFAULT_COUNTRY = "US";

function normalizePhone(phone) {
  if (!phone || typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return null;
  try {
    const input = digits.length <= 10 ? `+1${digits}` : `+${digits}`;
    const parsed = parsePhoneNumberWithError(input, DEFAULT_COUNTRY);
    return parsed ? parsed.format("E.164") : `+${digits}`;
  } catch {
    return digits.length > 0 ? `+${digits}` : null;
  }
}

// --- CRM API client with retry ---
const crmClient = axios.create({
  baseURL: CRM_URL,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

axiosRetry(crmClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    (error.response && error.response.status >= 500),
});

function crmRequest(functionName, parameters) {
  return crmClient.post(CRM_URL, {
    UserCode: CRM_USER_CODE,
    APIToken: CRM_API_KEY,
    Function: functionName,
    Parameters: parameters,
  });
}

// --- Health check ---
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "dialpad-crm-webhook" });
});

// --- Dialpad webhook ---
// Dialpad v2 can send JWT when secret is set; otherwise JSON. Only process "final" events to avoid duplicate notes.
const DIALPAD_FINAL_STATES = ["hangup", "recording", "call_transcription", "recap_summary"];

app.post("/dialpad-webhook", async (req, res) => {
  try {
    let call = req.body;
    if (DIALPAD_WEBHOOK_SECRET && req.rawBody) {
      try {
        const decoded = jwt.verify(req.rawBody.toString("utf8"), DIALPAD_WEBHOOK_SECRET, {
          algorithms: ["HS256"],
        });
        call = typeof decoded === "object" && decoded !== null ? decoded : req.body;
      } catch (err) {
        logger.warn("JWT verification failed", { message: err.message });
        return res.status(401).send("Invalid signature");
      }
    }
    // Dialpad v2: only create CRM note for final/recording events; ignore ringing/connected
    const state = call.state || call.event;
    if (state && !DIALPAD_FINAL_STATES.includes(state)) {
      logger.info("Skipping non-final event", { state });
      return res.status(200).send("OK");
    }
    // Dialpad uses external_number and contact.phone; support legacy from_number/customer_number
    const rawPhone =
      call.external_number ||
      call.contact?.phone ||
      call.from_number ||
      call.customer_number;
    const callType = call.direction || "unknown";
    const transcript =
      typeof call.transcript_url === "string"
        ? call.transcript_url
        : Array.isArray(call.transcript_url)
          ? call.transcript_url[0] || ""
          : "";
    const recordingRaw = call.recording_url ?? call.recording_details;
    const recording = Array.isArray(recordingRaw)
      ? recordingRaw[0]?.url || recordingRaw[0] || ""
      : typeof recordingRaw === "string"
        ? recordingRaw
        : "";

    const phone = normalizePhone(rawPhone) || rawPhone || "";
    logger.info("Incoming call event", {
      rawPhone,
      phone,
      callType,
      hasTranscript: !!transcript,
      hasRecording: !!recording,
    });

    if (!phone) {
      logger.warn("No phone number in webhook payload", { body: call });
      return res.status(400).send("Missing phone number");
    }

    // Step 1: Search contact (LAC uses GetContacts + SearchTerms)
    const searchResponse = await crmRequest("GetContacts", {
      SearchTerms: phone,
    });

    let contactId = null;
    const results = searchResponse.data?.Results || [];

    // LAC returns Phone as array of { Text, Type, TypeId }
    const contactPhoneMatches = (c, num) => {
      const phones = Array.isArray(c.Phone) ? c.Phone : c.Phone ? [c.Phone] : [];
      return phones.some(
        (p) => normalizePhone(typeof p === "string" ? p : p?.Text) === num
      );
    };

    if (results.length > 0) {
      if (results.length > 1) {
        const exactMatch = results.find((c) => contactPhoneMatches(c, phone));
        contactId = exactMatch ? exactMatch.ContactId : results[0].ContactId;
        if (!exactMatch) {
          logger.info("Multiple contacts found; using first match", {
            phone,
            count: results.length,
            contactId,
          });
        }
      } else {
        contactId = results[0].ContactId;
      }
    }

    // Step 2: Create contact if not found (LAC requires IsCompany, AssignedTo, Name)
    if (!contactId) {
      if (!CRM_ASSIGNED_TO) {
        logger.error("CRM_ASSIGNED_TO required to create new contacts");
        return res.status(500).send("Error");
      }
      logger.info("Contact not found; creating new contact", { phone });
      const createResponse = await crmRequest("CreateContact", {
        IsCompany: false,
        AssignedTo: CRM_ASSIGNED_TO,
        Name: phone,
        Phone: phone,
      });
      contactId = createResponse.data.ContactId;
    }

    // Step 3: Create activity note
    const noteText = [
      `Call Type: ${callType}`,
      transcript ? `Transcript: ${transcript}` : "",
      recording ? `Recording: ${recording}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await crmRequest("CreateNote", {
      ContactId: contactId,
      Note: noteText,
    });

    logger.info("CRM updated successfully", { contactId, phone });
    res.status(200).send("OK");
  } catch (error) {
    logger.error("Error processing webhook", {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
    });
    res.status(500).send("Error");
  }
});

// --- Startup ---
if (!CRM_API_KEY || !CRM_USER_CODE) {
  logger.error("Missing CRM_API_KEY or CRM_USER_CODE in environment");
  process.exit(1);
}
if (!CRM_ASSIGNED_TO) {
  logger.warn(
    "CRM_ASSIGNED_TO not set: new contacts cannot be created (search + note will still work)"
  );
}

app.listen(PORT, () => {
  logger.info(`Webhook server running on port ${PORT}`);
});
