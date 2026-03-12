require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const winston = require("winston");
const jwt = require("jsonwebtoken");
const { parsePhoneNumberWithError } = require("libphonenumber-js");
const crm = require("./crmClient");

const app = express();
// Capture raw body for /dialpad-webhook so we can verify JWT when DIALPAD_WEBHOOK_SECRET is set
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.url === "/dialpad-webhook" && buf && buf.length) req.rawBody = buf;
    },
  })
);

const CRM_ASSIGNED_TO = crm.CRM_ASSIGNED_TO;
const PORT = process.env.PORT || 3000;
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

// --- Phone normalization (E.164): strip spaces, ensure + prefix ---
const DEFAULT_COUNTRY = "US";

function normalizePhone(phone) {
  if (phone == null) return null;
  if (typeof phone !== "string") phone = String(phone);
  var s = phone.trim().replace(/\s/g, "");
  var digits = s.replace(/\D/g, "");
  if (digits.length === 0) return null;
  try {
    var input = digits.length <= 10 ? "+1" + digits : "+" + digits;
    var parsed = parsePhoneNumberWithError(input, DEFAULT_COUNTRY);
    return parsed ? parsed.format("E.164") : "+" + digits;
  } catch (e) {
    return digits.length > 0 ? "+" + digits : null;
  }
}

// --- Health check ---
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "dialpad-crm-webhook" });
});

// --- Dialpad call correlation ---
// We receive multiple webhook events for the same call. Keep them in memory by call_id,
// merge partial data, and create exactly one CRM note when enough data is present.
const DIALPAD_TRACKED_STATES = [
  "hangup",
  "recording",
  "call_transcription",
  "recap_summary",
  "recap_action_items",
];
const CALL_CACHE_TTL_MS = 15 * 60 * 1000;
const callCache = new Map();

function getCallId(payload) {
  if (!payload || typeof payload !== "object") return "";
  return (
    payload.call_id ||
    payload.callId ||
    payload.id ||
    (payload.call && payload.call.call_id) ||
    ""
  );
}

function extractRecordingUrl(payload) {
  var recordingRaw = payload.recording_url != null ? payload.recording_url : payload.recording_details;
  if (Array.isArray(recordingRaw)) {
    return (recordingRaw[0] && recordingRaw[0].url) || recordingRaw[0] || "";
  }
  if (typeof recordingRaw === "string") return recordingRaw;
  return "";
}

function extractTranscriptText(payload) {
  var text =
    payload.transcript_text ||
    payload.transcript ||
    payload.transcription_text ||
    payload.call_transcription ||
    (payload.call && payload.call.transcript_text) ||
    "";
  if (typeof text === "string") return text.trim();
  if (text && typeof text === "object" && typeof text.text === "string") return text.text.trim();
  if (typeof payload.transcript_url === "string") return payload.transcript_url;
  if (Array.isArray(payload.transcript_url)) return payload.transcript_url[0] || "";
  return "";
}

function extractSummary(payload) {
  var summary =
    payload.recap_summary ||
    payload.summary ||
    payload.call_summary ||
    (payload.recap && payload.recap.summary) ||
    "";
  if (typeof summary === "string") return summary.trim();
  return "";
}

function extractActionItems(payload) {
  var items = payload.recap_action_items || (payload.recap && payload.recap.action_items) || "";
  if (!items) return "";
  if (typeof items === "string") return items.trim();
  if (Array.isArray(items)) {
    var lines = items
      .map(function (item) {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return (item.text || item.action || item.item || "").trim();
        }
        return "";
      })
      .filter(Boolean)
      .map(function (line) {
        return "- " + line;
      });
    return lines.join("\n");
  }
  return "";
}

function buildCRMNote(callData) {
  var parts = [];
  parts.push("Call Type: " + (callData.callType || "unknown"));
  parts.push("");

  if (callData.summary) {
    parts.push("Summary:");
    parts.push(callData.summary);
    parts.push("");
  }
  if (callData.actionItems) {
    parts.push("Action Items:");
    parts.push(callData.actionItems);
    parts.push("");
  }
  if (callData.recording) {
    parts.push("Recording:");
    parts.push(callData.recording);
    parts.push("");
  }
  if (callData.transcript) {
    parts.push("Transcript:");
    parts.push(callData.transcript);
  }

  return parts.join("\n").trim();
}

function contactPhoneMatches(contact, number) {
  var phones = Array.isArray(contact.Phone) ? contact.Phone : contact.Phone ? [contact.Phone] : [];
  return phones.some(function (p) {
    var text = typeof p === "string" ? p : (p && p.Text);
    return normalizePhone(text) === number;
  });
}

async function findOrCreateContact(phone) {
  logger.info("Searching contact in CRM...", { phone: phone });
  var searchData = await crm.crmRequest("GetContacts", { SearchTerms: phone }, logger);
  var results = (searchData && searchData.Results) || [];
  var contactId = null;

  if (results.length > 0) {
    if (results.length > 1) {
      var exactMatch = results.find(function (c) {
        return contactPhoneMatches(c, phone);
      });
      contactId = exactMatch ? exactMatch.ContactId : results[0].ContactId;
      if (!exactMatch) {
        logger.info("Multiple contacts found; using first match", {
          phone: phone,
          count: results.length,
          contactId: contactId,
        });
      }
    } else {
      contactId = results[0].ContactId;
    }
    logger.info("Contact found: " + contactId, { contactId: contactId, phone: phone });
    return contactId;
  }

  if (!CRM_ASSIGNED_TO) {
    throw new Error("CRM_ASSIGNED_TO required to create new contacts");
  }

  logger.info("Contact not found; creating new contact...", { phone: phone });
  var createData = await crm.crmRequest(
    "CreateContact",
    {
      IsCompany: false,
      AssignedTo: CRM_ASSIGNED_TO,
      Name: phone,
      Phone: phone,
    },
    logger
  );
  contactId = createData && createData.ContactId;
  if (!contactId) throw new Error("CreateContact did not return ContactId");
  logger.info("Contact created: " + contactId, { contactId: contactId, phone: phone });
  return contactId;
}

async function tryCreateCRMNote(callData) {
  if (!callData.phone) return false;

  if (!callData.crmNoteCreated && callData.recording) {
    logger.info("Creating CRM note", { call_id: callData.call_id, phone: callData.phone });
    var contactId = await findOrCreateContact(callData.phone);
    var noteText = buildCRMNote(callData);
    var createNoteData = await crm.crmRequest(
      "CreateNote",
      { ContactId: contactId, Note: noteText },
      logger
    );

    callData.contactId = contactId;
    callData.crmNoteId = createNoteData && createNoteData.NoteId;
    callData.crmNoteCreated = true;
    callData.lastNoteText = noteText;
    callData.updatedAt = Date.now();

    logger.info("Note added to CRM. CRM updated successfully.", {
      call_id: callData.call_id,
      contactId: contactId,
      phone: callData.phone,
      noteId: callData.crmNoteId || "",
    });
    return true;
  }

  if (
    callData.crmNoteCreated &&
    callData.crmNoteId &&
    (callData.summary || callData.transcript || callData.actionItems)
  ) {
    var updatedNoteText = buildCRMNote(callData);
    if (updatedNoteText === callData.lastNoteText) return false;

    logger.info("Updating CRM note with summary", { call_id: callData.call_id });
    await crm.crmRequest(
      "EditNote",
      { NoteId: callData.crmNoteId, Note: updatedNoteText },
      logger
    );
    callData.lastNoteText = updatedNoteText;
    callData.updatedAt = Date.now();
    return true;
  }

  return false;
}

function scheduleCallCleanup(callId) {
  setTimeout(function () {
    callCache.delete(callId);
  }, CALL_CACHE_TTL_MS);
}

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
    const state = call.state || call.event;
    logger.info("Received Dialpad event: " + state, {
      state: state,
      call_id: getCallId(call),
    });

    if (state && !DIALPAD_TRACKED_STATES.includes(state)) {
      logger.info("Skipping non-final event", { state });
      return res.status(200).send("OK");
    }

    const callId = getCallId(call);
    if (!callId) {
      logger.warn("Missing call_id in webhook payload; cannot correlate events", { state: state });
      return res.status(200).send("OK");
    }

    // Dialpad uses external_number and contact.phone; support legacy from_number/customer_number
    const rawPhone =
      call.external_number ||
      (call.contact && call.contact.phone) ||
      call.from_number ||
      call.customer_number;
    const callType = call.direction || "unknown";
    const phone = normalizePhone(rawPhone) || (rawPhone && String(rawPhone).trim()) || "";
    const recording = extractRecordingUrl(call);
    const transcriptText = extractTranscriptText(call);
    const summary = extractSummary(call);
    const actionItems = extractActionItems(call);

    logger.info("Incoming call event", {
      rawPhone: rawPhone,
      phone: phone,
      callType: callType,
      call_id: callId,
      hasTranscript: !!transcriptText,
      hasRecording: !!recording,
      hasSummary: !!summary,
      hasActionItems: !!actionItems,
    });

    var cached = callCache.get(callId);
    if (!cached) {
      cached = {
        call_id: callId,
        phone: phone || "",
        callType: callType || "unknown",
        recording: "",
        transcript: "",
        summary: "",
        actionItems: "",
        crmNoteCreated: false,
        crmNoteId: "",
        lastNoteText: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      callCache.set(callId, cached);
      scheduleCallCleanup(callId);
    }

    logger.info("Updating cached call data for call_id", { call_id: callId, state: state });
    if (phone) cached.phone = phone;
    if (callType) cached.callType = callType;
    if (recording) cached.recording = recording;
    if (transcriptText) cached.transcript = transcriptText;
    if (summary) cached.summary = summary;
    if (actionItems) cached.actionItems = actionItems;
    cached.updatedAt = Date.now();

    try {
      await tryCreateCRMNote(cached);
    } catch (err) {
      logger.error("Error creating/updating CRM note for call_id", {
        call_id: callId,
        message: err.message,
        status: err.response && err.response.status,
        body: err.response && err.response.data,
      });
      return res.status(500).send("Error");
    }

    res.status(200).send("OK");
  } catch (error) {
    logger.error("Error processing webhook", {
      message: error.message,
      stack: error.stack,
      response: error.response && error.response.data,
    });
    res.status(500).send("Error");
  }
});

// --- Startup: validate .env ---
function validateEnv() {
  var missing = [];
  if (!crm.CRM_API_KEY) missing.push("CRM_API_KEY");
  if (crm.CRM_API_VERSION === "v1" && !crm.CRM_USER_CODE) missing.push("CRM_USER_CODE");
  if (missing.length > 0) {
    logger.error("Missing required env: " + missing.join(", "));
    process.exit(1);
  }
  if (!CRM_ASSIGNED_TO) {
    logger.warn(
      "CRM_ASSIGNED_TO not set: new contacts cannot be created (search + note will still work)"
    );
  }
  logger.info("CRM API version: " + crm.CRM_API_VERSION);
}

validateEnv();

app.listen(PORT, function () {
  logger.info("Webhook server running on port " + PORT);
});
