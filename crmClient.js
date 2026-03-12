/**
 * Less Annoying CRM API client.
 * Supports LAC v2 (Authorization header) and legacy (UserCode/APIToken in body).
 * LAC v2: POST https://api.lessannoyingcrm.com/v2/ with Authorization: API_KEY, body { Function, Parameters }
 * Legacy: POST https://api.lessannoyingcrm.com with body { UserCode, APIToken, Function, Parameters }
 */

require("dotenv").config();

const axios = require("axios");
const axiosRetry = require("axios-retry").default || require("axios-retry");

const CRM_URL_BASE = "https://api.lessannoyingcrm.com";
const CRM_URL_V2 = CRM_URL_BASE + "/v2/";

const CRM_API_KEY = process.env.CRM_API_KEY && process.env.CRM_API_KEY.trim();
const CRM_USER_CODE = process.env.CRM_USER_CODE && process.env.CRM_USER_CODE.trim();
const CRM_ASSIGNED_TO = process.env.CRM_ASSIGNED_TO && process.env.CRM_ASSIGNED_TO.trim();
const CRM_API_VERSION = (process.env.CRM_API_VERSION && process.env.CRM_API_VERSION.trim()) || "v2";

function getRequestConfig(functionName, parameters) {
  const body =
    CRM_API_VERSION === "v2"
      ? { Function: functionName, Parameters: parameters || {} }
      : {
          UserCode: CRM_USER_CODE,
          APIToken: CRM_API_KEY,
          Function: functionName,
          Parameters: parameters || {},
        };

  const url = CRM_API_VERSION === "v2" ? CRM_URL_V2 : CRM_URL_BASE;
  const headers = { "Content-Type": "application/json" };
  if (CRM_API_VERSION === "v2" && CRM_API_KEY) {
    headers.Authorization = CRM_API_KEY;
  }

  return { url: url, body: body, headers: headers };
}

const crmClient = axios.create({
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

axiosRetry(crmClient, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: function (error) {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      (error.response && error.response.status >= 500)
    );
  },
});

/**
 * Call a Less Annoying CRM API function.
 * @param {string} functionName - e.g. GetContacts, CreateContact, CreateNote
 * @param {object} parameters - Parameters for the function
 * @param {object} log - Optional logger with .info(message) and .error(message, meta)
 * @returns {Promise<object>} API response data
 */
function crmRequest(functionName, parameters, log) {
  const config = getRequestConfig(functionName, parameters);

  if (log) {
    log.info("CRM request: " + functionName, {
      Function: functionName,
      Parameters: parameters,
      URL: config.url,
      Auth: CRM_API_VERSION === "v2" ? "Authorization header" : "UserCode+APIToken in body",
    });
  }

  return crmClient
    .post(config.url, config.body, { headers: config.headers })
    .then(function (response) {
      if (log) {
        log.info("CRM response: " + functionName, {
          Function: functionName,
          Status: response.status,
          Body: response.data,
        });
      }
      if (response.data && response.data.Error) {
        var err = new Error(response.data.Error);
        err.response = response;
        throw err;
      }
      return response.data;
    })
    .catch(function (error) {
      var status = error.response && error.response.status;
      var body = error.response && error.response.data;
      if (log) {
        log.error("CRM API error: " + functionName, {
          Function: functionName,
          Status: status,
          ResponseBody: body,
          Message: error.message,
        });
      }
      throw error;
    });
}

module.exports = {
  crmRequest: crmRequest,
  getRequestConfig: getRequestConfig,
  CRM_API_KEY: CRM_API_KEY,
  CRM_USER_CODE: CRM_USER_CODE,
  CRM_ASSIGNED_TO: CRM_ASSIGNED_TO,
  CRM_API_VERSION: CRM_API_VERSION,
};
