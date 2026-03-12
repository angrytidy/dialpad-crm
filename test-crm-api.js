#!/usr/bin/env node
/**
 * Test Less Annoying CRM API using credentials from .env.
 * Run: node test-crm-api.js
 * Tests: GetContacts, CreateContact (optional), CreateNote (optional).
 */

require("dotenv").config();

const crm = require("./crmClient");

var log = {
  info: function (msg, meta) {
    console.log("[INFO]", msg, meta ? JSON.stringify(meta, null, 2) : "");
  },
  error: function (msg, meta) {
    console.error("[ERROR]", msg, meta ? JSON.stringify(meta, null, 2) : "");
  },
};

function run() {
  if (!crm.CRM_API_KEY) {
    console.error("Missing CRM_API_KEY in .env");
    process.exit(1);
  }
  if (crm.CRM_API_VERSION === "v1" && !crm.CRM_USER_CODE) {
    console.error("Missing CRM_USER_CODE in .env (required for CRM_API_VERSION=v1)");
    process.exit(1);
  }

  console.log("CRM API version:", crm.CRM_API_VERSION);
  console.log("---");

  // 1. GetContacts (search by a test term, e.g. empty or a known phone)
  var searchTerm = process.argv[2] || "+15551234567";
  console.log("1. GetContacts with SearchTerms:", searchTerm);
  crm
    .crmRequest("GetContacts", { SearchTerms: searchTerm }, log)
    .then(function (data) {
      var results = (data && data.Results) || [];
      console.log("   Results count:", results.length);
      if (results.length > 0) {
        console.log("   First contact ID:", results[0].ContactId);
      }
      console.log("   Full response (keys):", data ? Object.keys(data) : []);

      // 2. Optional: CreateContact if CRM_ASSIGNED_TO is set (use a unique name to avoid duplicates)
      if (!crm.CRM_ASSIGNED_TO) {
        console.log("\n2. CreateContact skipped (CRM_ASSIGNED_TO not set)");
        console.log("3. CreateNote skipped (no contact created)");
        return;
      }

      var testName = "Dialpad Test " + Date.now();
      console.log("\n2. CreateContact:", testName);
      return crm
        .crmRequest(
          "CreateContact",
          {
            IsCompany: false,
            AssignedTo: crm.CRM_ASSIGNED_TO,
            Name: testName,
            Phone: "+15550000000",
          },
          log
        )
        .then(function (createData) {
          var contactId = createData && createData.ContactId;
          if (!contactId) {
            console.error("   CreateContact did not return ContactId");
            return;
          }
          console.log("   Contact created:", contactId);

          console.log("\n3. CreateNote on contact:", contactId);
          return crm
            .crmRequest(
              "CreateNote",
              {
                ContactId: contactId,
                Note: "Test note from test-crm-api.js at " + new Date().toISOString(),
              },
              log
            )
            .then(function (noteData) {
              console.log("   Note created. NoteId:", (noteData && noteData.NoteId) || "(none)");
            });
        });
    })
    .then(function () {
      console.log("\nDone.");
    })
    .catch(function (err) {
      console.error("\nTest failed:", err.message);
      if (err.response && err.response.data) {
        console.error("Response:", err.response.data);
      }
      process.exit(1);
    });
}

run();
