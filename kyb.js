// KYB Automation API Service in Node.js
// Full Implementation with Express.js and External Integrations

// Import libraries
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const { OpenAI } = require('openai');
const html = require('node-html-parser');
const { parse } = require('node-html-parser');

// Simple logging system
const logs = [];
const MAX_LOGS = 1000;

function logMessage(type, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    type,
    message,
    data: data ? (typeof data === 'object' ? JSON.stringify(data) : data) : null
  };
  
  console.log(`[${timestamp}] [${type}] ${message}`);
  logs.unshift(logEntry); // Add to beginning for newest first
  
  // Keep log size manageable
  if (logs.length > MAX_LOGS) {
    logs.pop();
  }
  
  // Also log to file
  const logDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, `kyb-${new Date().toISOString().split('T')[0]}.log`),
    `[${timestamp}] [${type}] ${message}${data ? ' ' + (typeof data === 'object' ? JSON.stringify(data) : data) : ''}\n`
  );
}

// Configuration (Environment Variables)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const COMPANY_HOUSE_API_KEY = process.env.COMPANY_HOUSE_API_KEY;
const PORT = process.env.PORT || 3000;

// Initialize services
const app = express();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Middleware
app.use(bodyParser.json());
app.use(cors()); // Enable CORS for all routes
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from /public

// Add request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // Log request body for POST requests
  if (req.method === 'POST' && req.body) {
    console.log(`Request Body:`, req.body);
  }
  
  // Log query parameters for GET requests
  if (req.method === 'GET' && Object.keys(req.query).length > 0) {
    console.log(`Query Params:`, req.query);
  }
  
  // Capture the response
  const originalSend = res.send;
  res.send = function(body) {
    const responseTime = Date.now() - start;
    console.log(`[${new Date().toISOString()}] Response ${res.statusCode} - ${responseTime}ms`);
    
    // Log response for non-ok status codes or if it's an error
    if (res.statusCode !== 200 || (typeof body === 'string' && body.includes('error'))) {
      console.log(`Response Body:`, body);
    }
    
    originalSend.call(this, body);
  };
  
  next();
});

// Add middleware to handle JSON circular references and ensure valid JSON responses
app.use((req, res, next) => {
  // Override res.json to handle circular references and other JSON errors
  const originalJson = res.json;
  res.json = function(obj) {
    try {
      // Try to detect circular references by stringifying the object
      JSON.stringify(obj);
      return originalJson.call(this, obj);
    } catch (err) {
      // If there's a circular reference or other JSON error, log it and send a sanitized response
      console.error(`JSON serialization error: ${err.message}`);
      
      // Create a safe copy of the object without circular references
      const safeObj = { 
        error: 'Response contained invalid JSON structure',
        message: err.message,
        timestamp: new Date().toISOString(),
        endpoint: req.originalUrl,
        method: req.method
      };
      
      // If this was an error response, preserve the error and status
      if (obj.error) {
        safeObj.original_error = typeof obj.error === 'string' ? obj.error : 'Complex error object';
      }
      
      // Set appropriate status if not already set
      if (res.statusCode === 200) {
        res.status(500);
      }
      
      return originalJson.call(this, safeObj);
    }
  };
  next();
});

// In-memory storage (for simplicity)
const jobStatus = {};
const jobLogs = {};
const jobQueue = [];
let isProcessing = false;

// Simple job processor function
async function processNextJob() {
  if (isProcessing || jobQueue.length === 0) return;
  
  isProcessing = true;
  const job = jobQueue.shift();
  
  try {
    console.log(`[${new Date().toISOString()}] Processing job ${job.id} for business "${job.business_name}"`);
    
    if (job.type === 'kybTask') {
      await jobProcessors.kybTask(job);
    } else if (job.type === 'kybContinue') {
      await jobProcessors.kybContinue(job);
    } else {
      console.error(`[${new Date().toISOString()}] Unknown job type: ${job.type}`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error processing job: ${err.message}`);
    jobStatus[job.id] = 'failed';
    jobLogs[job.id].push({
      step: 'Error',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  } finally {
    isProcessing = false;
    // Process next job if available
    processNextJob();
  }
}

// POST /startKYB
app.post('/startKYB', async (req, res) => {
  const { business_name } = req.body;
  if (!business_name) return res.status(400).json({ error: 'business_name is required' });

  const jobId = crypto.randomBytes(16).toString('hex');
  console.log(`[${new Date().toISOString()}] Creating new KYB job for "${business_name}" with ID: ${jobId}`);
  
  jobStatus[jobId] = 'pending';
  jobLogs[jobId] = [
    {
      step: 'Original Request',
      timestamp: new Date().toISOString(),
      data: { business_name }
    }
  ];
  
  // Add job to queue
  jobQueue.push({
    id: jobId,
    type: 'kybTask',
    business_name,
  });
  
  // Start processing if not already processing
  if (!isProcessing) {
    processNextJob();
  }

  return res.json({ job_id: jobId });
});

// GET /jobStatus
app.get('/jobStatus', (req, res) => {
  const { job_id } = req.query;
  if (!jobStatus[job_id]) return res.status(404).json({ error: 'Job not found' });
  console.log(`[${new Date().toISOString()}] Job status request for ${job_id}: ${jobStatus[job_id]}`);
  
  // Create a more detailed status response
  const statusResponse = {
    job_id: job_id,
    status: jobStatus[job_id],
    created_at: Array.isArray(jobLogs[job_id]) ? jobLogs[job_id]?.[0]?.timestamp || null : null,
    last_updated: new Date().toISOString(),
    total_steps_completed: Array.isArray(jobLogs[job_id]) ? jobLogs[job_id]?.length || 0 : 0,
    current_step: Array.isArray(jobLogs[job_id]) ? 
                 jobLogs[job_id]?.[jobLogs[job_id]?.length - 1]?.step || null : 
                 "Completed",
    requires_action: jobStatus[job_id] === 'action_required',
    required_fields: Array.isArray(jobLogs[job_id]) ? 
                    jobLogs[job_id]?.find?.(log => log.step === 'Action Required')?.required_fields || null : 
                    null,
    percent_complete: calculateJobProgress(jobStatus[job_id], Array.isArray(jobLogs[job_id]) ? jobLogs[job_id]?.length || 0 : 0)
  };
  
  return res.json(statusResponse);
});

// GET /jobLog
app.get('/jobLog', (req, res) => {
  try {
    const { job_id } = req.query;
    if (!jobLogs[job_id]) return res.status(404).json({ error: 'Job not found' });
    console.log(`[${new Date().toISOString()}] Job log request for ${job_id}`);
    
    // Check if the job has a completed result
    const hasResult = jobLogs[job_id].result !== undefined;
    
    // Safely process the job logs to ensure they can be serialized
    const safeLogEntries = jobLogs[job_id].map(entry => {
      try {
        // For each entry, create a safe copy that can be serialized
        const safeCopy = { ...entry };
        
        // Handle data field which might contain complex objects
        if (safeCopy.data && typeof safeCopy.data === 'object') {
          try {
            // Test if it can be serialized
            JSON.stringify(safeCopy.data);
          } catch (err) {
            // If it can't be serialized, provide a safe version
            safeCopy.data = { 
              serialization_error: true, 
              message: 'Data could not be serialized to JSON',
              error: err.message
            };
          }
        }
        
        // Handle result field similarly for the completed entry
        if (safeCopy.result && typeof safeCopy.result === 'object') {
          try {
            // Test if it can be serialized
            JSON.stringify(safeCopy.result);
          } catch (err) {
            safeCopy.result = { 
              serialization_error: true, 
              message: 'Result could not be serialized to JSON',
              error: err.message
            };
          }
        }
        
        // Handle error field
        if (safeCopy.error && typeof safeCopy.error === 'object') {
          safeCopy.error = safeCopy.error.message || 'Unknown error';
        }
        
        return safeCopy;
      } catch (err) {
        // If processing an entry fails, return a placeholder
        return { 
          step: 'Log Entry Error',
          timestamp: new Date().toISOString(),
          error: `Could not process log entry: ${err.message}`
        };
      }
    });
    
    // Create an enhanced response with job metadata
    const response = {
      job_id: job_id,
      status: jobStatus[job_id] || 'unknown',
      created_at: jobLogs[job_id][0]?.timestamp || null,
      last_updated: jobLogs[job_id][jobLogs[job_id].length - 1]?.timestamp || new Date().toISOString(),
      log_entries: safeLogEntries,
      total_steps: jobLogs[job_id].length,
      percent_complete: calculateJobProgress(jobStatus[job_id], jobLogs[job_id].length),
      requires_action: jobStatus[job_id] === 'action_required',
      required_fields: jobLogs[job_id].find(log => log.step === 'Action Required')?.required_fields || null,
      is_complete: hasResult
    };
    
    // Add the final result if available
    if (hasResult) {
      try {
        // Test if result can be serialized
        JSON.stringify(jobLogs[job_id].result);
        response.result = jobLogs[job_id].result;
      } catch (err) {
        response.result = { 
          serialization_error: true, 
          message: 'Result could not be serialized to JSON',
          error: err.message
        };
      }
    }
    
    // Ensure we can serialize the entire response
    try {
      JSON.stringify(response);
      return res.json(response);
    } catch (jsonError) {
      console.error(`Error serializing response for job ${job_id}:`, jsonError.message);
      // Return a simplified response if the full one can't be serialized
      return res.json({
        job_id: job_id,
        status: jobStatus[job_id] || 'unknown',
        error: 'Could not serialize full job logs',
        serialization_error: true,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('Error in jobLog endpoint:', err.message);
    return res.status(500).json({
      error: 'Internal server error: ' + err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /continueKYB - Provide additional information to continue a stuck KYB process
app.post('/continueKYB', async (req, res) => {
  const { job_id, ...additionalData } = req.body;
  
  if (!job_id) return res.status(400).json({ error: 'job_id is required' });
  if (!jobStatus[job_id]) return res.status(404).json({ error: 'Job not found' });
  
  console.log(`[${new Date().toISOString()}] Continuing KYB job ${job_id} with additional data:`, additionalData);
  
  // Only allow continuing jobs that are in action_required status
  if (jobStatus[job_id] !== 'action_required') {
    return res.status(400).json({ 
      error: 'Job is not awaiting additional information', 
      current_status: jobStatus[job_id] 
    });
  }
  
  // Add the additional data to job logs
  jobLogs[job_id].push({
    step: 'Additional Information',
    timestamp: new Date().toISOString(),
    data: additionalData
  });
  
  // Update job status to processing
  jobStatus[job_id] = 'processing';
  
  // Get the business name from the original job data
  const businessName = jobLogs[job_id].find(log => log.step === 'Original Request')?.data?.business_name;
  
  // Add continuation job to queue
  jobQueue.push({
    id: job_id,
    type: 'kybContinue',
    business_name: businessName,
    additionalData
  });
  
  // Start processing if not already processing
  if (!isProcessing) {
    processNextJob();
  }
  
  if (additionalData.crn) {
    return res.json({ 
      status: 'processing',
      message: 'Job continuing with provided CRN' 
    });
  } 
  else if (additionalData.website) {
    return res.json({ 
      status: 'processing',
      message: 'Job continuing with provided website' 
    });
  }
  else {
    return res.json({ 
      status: 'processing',
      message: 'Job continuing with provided information' 
    });
  }
});

// GET /searchCompany - Search Companies House by name
app.get('/searchCompany', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Company name is required' });
    if (!COMPANY_HOUSE_API_KEY) return res.status(500).json({ error: 'Companies House API key not configured' });

    const searchUrl = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(name)}`;
    const searchResponse = await axios.get(searchUrl, {
      auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
    });
    
    if (searchResponse.data.items && searchResponse.data.items.length > 0) {
      // Return the top 5 matches with enhanced information
      const topMatches = searchResponse.data.items.slice(0, 5).map(item => ({
        company_name: item.title,
        company_number: item.company_number,
        company_status: item.company_status,
        company_type: item.company_type || null,
        address: item.address_snippet,
        address_fields: item.address || null,
        description: item.description || null,
        date_of_creation: item.date_of_creation || null,
        matched_terms: item.matches?.title || [],
        similarity_score: calculateNameSimilarity(name, item.title),
        kind: item.kind || null,
        links: item.links || null,
        sic_codes: item.sic_codes || [],
        is_active: item.company_status === 'active',
        search_match_type: item.kind || 'company',
        date_of_cessation: item.date_of_cessation || null,
        registered_office_address: item.registered_office_address || null
      }));
      
      return res.json({ 
        query: name,
        total_results: searchResponse.data.total_results || searchResponse.data.items.length,
        page_number: searchResponse.data.page_number || 1,
        results: topMatches,
        timestamp: new Date().toISOString()
      });
    } else {
      return res.json({ 
        query: name,
        total_results: 0,
        results: [],
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('Error searching company:', err.message);
    return res.status(500).json({ error: 'Error searching Companies House: ' + err.message });
  }
});

// GET /companyProfile - Get detailed company profile by CRN
app.get('/companyProfile', async (req, res) => {
  try {
    const { crn } = req.query;
    if (!crn) return res.status(400).json({ error: 'Company Registration Number (CRN) is required' });
    if (!COMPANY_HOUSE_API_KEY) return res.status(500).json({ error: 'Companies House API key not configured' });

    try {
      const companyData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
        auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
        headers: {
          'Accept': 'application/json'
        },
        validateStatus: function (status) {
          // Consider only 2xx status codes as successful
          return status >= 200 && status < 300;
        }
      });
      
      // Add minimal enhancements while preserving original data
      const enhancedResponse = {
        ...companyData.data,
        request_timestamp: new Date().toISOString(),
        queried_crn: crn,
        profile_url: `https://find-and-update.company-information.service.gov.uk/company/${crn}`,
        is_active: companyData.data.company_status === 'active'
      };
      
      return res.json(enhancedResponse);
    } catch (apiError) {
      // Handle specific API errors
      if (apiError.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        const status = apiError.response.status;
        
        if (status === 404) {
          return res.status(404).json({ 
            error: `Company not found with CRN: ${crn}`,
            crn: crn,
            status: 'not_found',
            timestamp: new Date().toISOString()
          });
        } else if (status === 401 || status === 403) {
          return res.status(status).json({ 
            error: 'API authentication error - invalid Companies House API key',
            crn: crn,
            status: 'auth_error',
            timestamp: new Date().toISOString()
          });
        } else if (status === 429) {
          return res.status(429).json({ 
            error: 'Companies House API rate limit exceeded',
            crn: crn,
            status: 'rate_limited',
            timestamp: new Date().toISOString()
          });
        } else {
          return res.status(status).json({ 
            error: `Companies House API error: ${status}`,
            crn: crn,
            status: 'api_error',
            status_code: status,
            timestamp: new Date().toISOString()
          });
        }
      } else if (apiError.request) {
        // The request was made but no response was received
        return res.status(500).json({ 
          error: 'No response received from Companies House API',
          crn: crn,
          status: 'network_error',
          timestamp: new Date().toISOString()
        });
      } else {
        // Something happened in setting up the request that triggered an Error
        return res.status(500).json({ 
          error: `Error setting up request: ${apiError.message}`,
          crn: crn,
          status: 'request_error',
          timestamp: new Date().toISOString()
        });
      }
    }
  } catch (err) {
    // Catch any other errors and return a valid JSON response
    console.error('Error in companyProfile endpoint:', err.message);
    return res.status(500).json({ 
      error: 'Internal server error: ' + err.message,
      crn: req.query.crn,
      status: 'server_error',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /allLogs - View all job logs (for debugging)
app.get('/allLogs', (req, res) => {
  return res.json({
    totalJobs: Object.keys(jobLogs).length,
    jobLogs: jobLogs,
    jobStatus: jobStatus
  });
});

// Utility function to validate and match addresses
function normalizeAddress(addr) {
  return addr.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function downloadIncorporationDocument(crn, jobId) {
  try {
    const filings = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}/filing-history`, {
      auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
    });
    const incorporation = filings.data.items.find(item => item.type === 'NEWINC');
    if (incorporation) {
      const docId = incorporation.links.document_metadata.split('/').pop();
      const document = await axios.get(`https://document-api.company-information.service.gov.uk/document/${docId}/content`, {
        auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
        responseType: 'arraybuffer'
      });
      const filePath = path.join(__dirname, 'inc_docs', `${jobId}_incorporation.pdf`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, document.data);
      return `/inc_docs/${jobId}_incorporation.pdf`;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Add job processor methods for better organization
const jobProcessors = {
  // Process initial KYB requests
  async kybTask(job) {
    const { id: jobId, business_name } = job;

    console.log(`[${new Date().toISOString()}] Starting KYB process for "${business_name}" (Job ID: ${jobId})`);

    try {
      jobStatus[jobId] = 'processing';

      // Step 1: Get CRN and Website from OpenAI with improved prompt for accuracy
      console.log(`[${new Date().toISOString()}] [${jobId}] Querying OpenAI for CRN information`);
      const openaiPrompt = `Search for a company whose registered name closely matches (at least 90% similarity) the requested business name.

If multiple matches exist, prefer:

Exact or closest match in name.

Companies with ACTIVE status over DISSOLVED or INACTIVE.

Do not guess or assume a company is correct based only on partial word matches. Only select a company if the similarity is high and reasonable.

If no suitable company is found, return all fields as null and explain briefly inside a reason field.

Input Variable: ${business_name}

Output JSON Format:

{
  "crn": "Company Registration Number (CRN) or null",
  "company_name_in_registry": "Exact company name as registered or null",
  "company_status": "Company status (ACTIVE, DISSOLVED, etc.) or null",
  "registry_link": "Direct URL to Companies House page or null",
  "reason": "Explanation if no valid match found, otherwise null"
}`;
      
      console.log(`[${new Date().toISOString()}] [${jobId}] OpenAI Request:`, { 
        model: 'chatgpt-4o-latest',
        prompt: openaiPrompt
      });
      
      let aiText = '';
      try {
        // Set a timeout for the OpenAI request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        try {
          const gptResponse = await openai.chat.completions.create({
            model: 'chatgpt-4o-latest',
            messages: [{ 
              role: 'user', 
              content: openaiPrompt
            }],
            temperature: 0,
            max_tokens: 500 // Limit response size
          });
          
          aiText = gptResponse.choices[0].message.content;
          console.log(`[${new Date().toISOString()}] [${jobId}] OpenAI Response:`, {
            content: aiText,
            finish_reason: gptResponse.choices[0].finish_reason,
            model: gptResponse.model,
            usage: gptResponse.usage
          });
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new Error('OpenAI request timed out after 30 seconds');
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [${jobId}] OpenAI request failed: ${error.message}`);
        jobLogs[jobId].push({ 
          step: 'GPT Error', 
          error: error.message || 'Unknown error during OpenAI request'
        });
        aiText = `Error getting information for ${business_name}`;
      }
      
      jobLogs[jobId].push({ step: 'CRN Search Result', data: aiText });

      // Try to find CRN with various patterns
      let crn = null;
      let companyStatusFromAI = null;
      
      // Try to parse the JSON response
      try {
        const jsonResponse = JSON.parse(aiText);
        if (jsonResponse.crn) {
          crn = jsonResponse.crn;
          companyStatusFromAI = jsonResponse.company_status;
          
          // Log verification steps and status
          jobLogs[jobId].push({ 
            step: 'CRN Verification', 
            data: {
              crn: jsonResponse.crn,
              company_name: jsonResponse.company_name_in_registry,
              status: jsonResponse.company_status,
              confidence: jsonResponse.confidence,
              incorporation_date: jsonResponse.incorporation_date,
              registry_link: jsonResponse.registry_link
            }
          });
          
          // Extra verification step: Double-check CRN with Companies House immediately
          try {
            console.log(`[${new Date().toISOString()}] [${jobId}] Performing immediate CRN verification for ${crn}`);
            const verifyResponse = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
              auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
              timeout: 8000
            });
            
            if (verifyResponse.data && verifyResponse.data.company_name) {
              const foundCompanyName = verifyResponse.data.company_name;
              const nameSimilarity = calculateNameSimilarity(foundCompanyName.toLowerCase(), business_name.toLowerCase());
              
              console.log(`[${new Date().toISOString()}] [${jobId}] CRN verification result: ${foundCompanyName} (similarity: ${nameSimilarity.toFixed(2)})`);
              
              // If very low similarity, reject this CRN immediately
              if (nameSimilarity < 0.4) {
                console.log(`[${new Date().toISOString()}] [${jobId}] REJECTING CRN - found wrong company: ${foundCompanyName}`);
                jobLogs[jobId].push({ 
                  step: 'CRN Verification Failed', 
                  data: {
                    requested_company: business_name,
                    found_company: foundCompanyName,
                    crn: crn,
                    similarity: nameSimilarity.toFixed(2),
                    error: "Company name mismatch - wrong company identified"
                  }
                });
                // Reset CRN since it's incorrect
                crn = null;
              }
            }
          } catch (verifyError) {
            console.log(`[${new Date().toISOString()}] [${jobId}] Initial CRN verification failed: ${verifyError.message}`);
            // Don't reject CRN here, we'll do full verification later
          }
        }
      } catch (parseError) {
        console.error(`[${new Date().toISOString()}] [${jobId}] JSON parse error: ${parseError.message}`);
        
        // Try explicit label first using regex if JSON parsing fails
        const crnLabelMatch = aiText.match(/CRN:\s*([A-Z]{0,2}\d{6,8})/);
        if (crnLabelMatch) {
          crn = crnLabelMatch[1];
        } else {
          // Try standard UK CRN patterns
          const crnPatterns = [
            /\b([A-Z]{2}\d{6,8})\b/,  // Format: SC123456, NI123456
            /\b(\d{8})\b/,          // Format: 12345678
            /Company Number:?\s*([A-Z]{0,2}\d{6,8})/i,
            /Registration Number:?\s*([A-Z]{0,2}\d{6,8})/i,
            /Company Registration Number:?\s*([A-Z]{0,2}\d{6,8})/i
          ];

          for (const pattern of crnPatterns) {
            const match = aiText.match(pattern);
            if (match) {
              crn = match[1];
              break;
            }
          }
        }
      }

      // If CRN still not found, try a direct Companies House search
      if (!crn) {
        try {
          // Fallback: Try to search Companies House directly by company name
          console.log(`[${new Date().toISOString()}] [${jobId}] CRN not found in AI response, attempting Companies House search`);
          jobLogs[jobId].push({ step: 'CRN Fallback', message: 'Attempting Companies House search by name' });
          
          const searchUrl = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(business_name)}`;
          const searchResponse = await axios.get(searchUrl, {
            auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
          });
          
          if (searchResponse.data.items && searchResponse.data.items.length > 0) {
            // Find the active company with closest name match
            const activeCompanies = searchResponse.data.items.filter(item => 
              item.company_status === 'active' && 
              calculateNameSimilarity(item.title.toLowerCase(), business_name.toLowerCase()) > 0.7
            );
            
            if (activeCompanies.length > 0) {
              // Take the best match
              const bestMatch = activeCompanies[0];
              crn = bestMatch.company_number;
              companyStatusFromAI = bestMatch.company_status;
              
              // Double-check immediately with full profile to ensure correct company
              try {
                console.log(`[${new Date().toISOString()}] [${jobId}] Verifying Companies House search result: ${crn}`);
                const verifyResponse = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
                  auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
                  timeout: 8000
                });
                
                if (verifyResponse.data && verifyResponse.data.company_name) {
                  const foundCompanyName = verifyResponse.data.company_name;
                  const nameSimilarity = calculateNameSimilarity(foundCompanyName.toLowerCase(), business_name.toLowerCase());
                  
                  // If very low similarity, reject this CRN
                  if (nameSimilarity < 0.4) {
                    console.log(`[${new Date().toISOString()}] [${jobId}] REJECTING Search result CRN - found wrong company: ${foundCompanyName}`);
                    jobLogs[jobId].push({ 
                      step: 'Search Result Verification Failed', 
                      data: {
                        requested_company: business_name,
                        found_company: foundCompanyName,
                        crn: crn,
                        similarity: nameSimilarity.toFixed(2),
                        error: "Company name mismatch - wrong company identified"
                      }
                    });
                    // Reset CRN since it's incorrect
                    crn = null;
                  } else {
                    console.log(`[${new Date().toISOString()}] [${jobId}] Found active company via Companies House search: ${foundCompanyName} (CRN: ${crn})`);
                    jobLogs[jobId].push({ 
                      step: 'Companies House Search Result', 
                      data: {
                        company_name: foundCompanyName,
                        crn: crn,
                        status: bestMatch.company_status,
                        similarity_score: nameSimilarity.toFixed(2)
                      }
                    });
                  }
                }
              } catch (verifyError) {
                console.log(`[${new Date().toISOString()}] [${jobId}] Companies House verification failed: ${verifyError.message}`);
                // We'll keep the CRN and do further verification later
              }
            } else {
              console.log(`[${new Date().toISOString()}] [${jobId}] No active company matches found via Companies House search`);
            }
          } else {
            console.log(`[${new Date().toISOString()}] [${jobId}] No matches found via Companies House search`);
          }
        } catch (err) {
          console.error(`[${new Date().toISOString()}] [${jobId}] Companies House search failed: ${err.message}`);
          jobLogs[jobId].push({ step: 'Companies House Search Failed', error: err.message });
        }
      }

      // If still no CRN found, try one more time with a more specific OpenAI prompt
      if (!crn) {
        try {
          console.log(`[${new Date().toISOString()}] [${jobId}] Attempting second AI query for CRN`);
          jobLogs[jobId].push({ step: 'CRN Second Attempt', message: 'Trying with more specific AI prompt' });
          
          const secondPrompt = `I need ONLY the UK company registration number for "${business_name}" that is CURRENTLY ACTIVE. 
          
          FOLLOW THESE INSTRUCTIONS EXACTLY:
          1. Search for a company whose registered name closely matches (at least 90% similarity) the requested business name.
          2. The company MUST be ACTIVE in Companies House records
          3. Do NOT provide a CRN for a similarly named company or subsidiary with less than 90% name similarity
          4. Verify the spelling matches closely
          
          Format: "CRN: 12345678" or "CRN: SC123456" followed by "COMPANY NAME: [exact name in registry]"
          
          If you cannot find a close match (at least 90% similarity), or if the company is not active, respond with "No active CRN found for this company name".`;
          
          console.log(`[${new Date().toISOString()}] [${jobId}] Second OpenAI Request:`, { 
            model: 'chatgpt-4o-latest',
            prompt: secondPrompt
          });
          
          // Set a timeout for the OpenAI request
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          let secondAttemptText = '';
          try {
            const secondAttemptResponse = await openai.chat.completions.create({
              model: 'chatgpt-4o-latest',
              messages: [{ 
                role: 'user', 
                content: secondPrompt
              }],
              temperature: 0,
              max_tokens: 200 // Limit response size
            });
            
            secondAttemptText = secondAttemptResponse.choices[0].message.content;
            console.log(`[${new Date().toISOString()}] [${jobId}] Second OpenAI Response:`, {
              content: secondAttemptText,
              finish_reason: secondAttemptResponse.choices[0].finish_reason,
              model: secondAttemptResponse.model,
              usage: secondAttemptResponse.usage
            });
          } catch (err) {
            if (err.name === 'AbortError') {
              console.error(`[${new Date().toISOString()}] [${jobId}] Second OpenAI request timed out after 30 seconds`);
              throw new Error('Second OpenAI request timed out');
            }
            throw err;
          } finally {
            clearTimeout(timeoutId);
          }
          
          if (secondAttemptText.toLowerCase().includes("no active crn found")) {
            jobLogs[jobId].push({ 
              step: 'Second AI Attempt', 
              data: { 
                message: "AI could not find an active CRN for this company",
                response: secondAttemptText 
              } 
            });
            
            // Handle "not found" case by setting CRN to null but not raising an action required
            console.log(`[${new Date().toISOString()}] [${jobId}] No matching company found for "${business_name}", but we'll continue the flow`);
            crn = null;
            // We'll let the flow continue, and the processCRN method will handle the null CRN case
          } else {
            const secondMatch = secondAttemptText.match(/CRN:\s*([A-Z]{0,2}\d{6,8})/i);
            
            if (secondMatch) {
              crn = secondMatch[1];
              jobLogs[jobId].push({ step: 'Second AI Attempt', data: secondAttemptText });
            }
          }
        } catch (err) {
          console.error(`[${new Date().toISOString()}] [${jobId}] Second AI attempt failed: ${err.message}`);
          jobLogs[jobId].push({ step: 'Second AI Attempt Failed', error: err.message });
        }
      }

      if (!crn) {
        console.log(`[${new Date().toISOString()}] [${jobId}] CRN not found by any method, marking job as action_required`);
        jobStatus[jobId] = 'action_required';
        jobLogs[jobId].push({ 
          step: 'Action Required', 
          timestamp: new Date().toISOString(),
          message: 'Could not find active CRN automatically. Please provide the Company Registration Number or additional details.',
          required_fields: {
            crn: 'Company Registration Number (8 digits or 2 letters + 6 digits) for an ACTIVE company',
            website: 'Company website URL (optional)',
            company_name: 'Exact company name (optional)'
          }
        });
        return; // End processing here, waiting for user input
      }
      
      // Verify CRN directly with Companies House before proceeding
      console.log(`[${new Date().toISOString()}] [${jobId}] Verifying CRN directly with Companies House: ${crn}`);
      try {
        const companyResponse = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
          auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
          timeout: 10000
        });
        
        const companyData = companyResponse.data;
        
        // Verify the company is active
        if (companyData.company_status !== 'active') {
          console.log(`[${new Date().toISOString()}] [${jobId}] Company is not active, status: ${companyData.company_status}`);
          jobStatus[jobId] = 'action_required';
          jobLogs[jobId].push({ 
            step: 'Company Status Error', 
            timestamp: new Date().toISOString(),
            message: `The identified company (${companyData.company_name}) with CRN ${crn} is not active. Status: ${companyData.company_status}`,
            data: companyData,
            required_fields: {
              crn: 'Please provide a CRN for an ACTIVE company'
            }
          });
          return;
        }
        
        // Verify the company name is similar to the requested one
        const nameSimilarity = calculateNameSimilarity(companyData.company_name.toLowerCase(), business_name.toLowerCase());
        console.log(`[${new Date().toISOString()}] [${jobId}] Company name comparison: "${business_name}" vs "${companyData.company_name}" - similarity: ${nameSimilarity.toFixed(2)}`);
        
        if (nameSimilarity < 0.5) {
          console.log(`[${new Date().toISOString()}] [${jobId}] Company name similarity is low: ${nameSimilarity.toFixed(2)}`);
          console.log(`[${new Date().toISOString()}] [${jobId}] Requested: "${business_name}", Found: "${companyData.company_name}"`);
          
          jobLogs[jobId].push({ 
            step: 'Company Name Verification', 
            data: {
              requested_name: business_name,
              found_name: companyData.company_name,
              similarity_score: nameSimilarity.toFixed(2),
              warning: nameSimilarity < 0.5 ? "Company name significantly different from requested" : null
            }
          });
          
          // If similarity is very low, most likely this is the wrong company - request specific CRN
          if (nameSimilarity < 0.3) {
            jobStatus[jobId] = 'action_required';
            jobLogs[jobId].push({ 
              step: 'Wrong Company Detected', 
              timestamp: new Date().toISOString(),
              message: `ERROR: Found company "${companyData.company_name}" with CRN ${crn}, but this appears to be a completely different company from "${business_name}". Please provide the correct CRN.`,
              data: { 
                found_company: companyData.company_name,
                requested_company: business_name,
                similarity_score: nameSimilarity.toFixed(2),
                error: "Name similarity too low - wrong company detected" 
              },
              required_fields: {
                crn: `Please provide the correct CRN for "${business_name}" (not for "${companyData.company_name}")`
              }
            });
            return;
          }
          
          // For moderate mismatch, ask for confirmation
          if (nameSimilarity < 0.5) {
            jobStatus[jobId] = 'action_required';
            jobLogs[jobId].push({ 
              step: 'Action Required', 
              timestamp: new Date().toISOString(),
              message: `Found company "${companyData.company_name}" with CRN ${crn}, but the name is different from "${business_name}". Please confirm if this is correct.`,
              data: { 
                found_company: companyData.company_name,
                requested_company: business_name,
                similarity_score: nameSimilarity.toFixed(2) 
              },
              required_fields: {
                confirm_company: 'Type "yes" to confirm this is the correct company, or provide a different CRN'
              }
            });
            return;
          }
        }
        
        // Now we have a valid CRN for an active company, next fetch the website
        console.log(`[${new Date().toISOString()}] [${jobId}] Successfully verified active company: ${companyData.company_name} (${crn})`);
        
        // Step 2: Get Website using a separate OpenAI call
        console.log(`[${new Date().toISOString()}] [${jobId}] Fetching website for ${companyData.company_name}`);
        const websitePrompt = `Find the official corporate website URL for "${companyData.company_name}" (UK Company Registration Number: ${crn}).

CRITICAL VERIFICATION INSTRUCTIONS - YOU MUST FOLLOW THESE EXACTLY:
1. Find the official company website only - the highest priority.
2. Website must be the official corporate website, not a third-party directory or social media page.
3. Website should be verified through multiple sources (Companies House, company documents, etc.).
4. Ensure it's the main corporate website, not a subsidiary or regional site.

WEBSITE VERIFICATION STEPS (MUST FOLLOW):
1. Search for the official company website using the exact company name
2. Verify the website is active and belongs to the company
3. Check for website mentions in Companies House records
4. Look for website in company documents and filings
5. Verify website through multiple sources
6. Ensure it's the main corporate website, not a subsidiary site
7. Check for website in company's social media profiles
8. Verify through business directories and listings

POTENTIAL ERRORS TO AVOID:
- DO NOT return third-party websites or directories
- DO NOT return social media profiles as official websites
- DO NOT guess or estimate website urls - only provide verified information

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:
{
  "website": "The official website URL or null if uncertain",
  "confidence": "HIGH, MEDIUM, LOW, or NONE",
  "verification_steps": ["List each verification step you performed"],
  "sources": ["List sources where website was found"]
}`;
        
        console.log(`[${new Date().toISOString()}] [${jobId}] Website Search OpenAI Request`);
        
        let websiteAiText = '';
        try {
          // Set a timeout for the OpenAI request
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          try {
            const websiteResponse = await openai.chat.completions.create({
              model: 'chatgpt-4o-latest',
              messages: [{ 
                role: 'user', 
                content: websitePrompt
              }],
              temperature: 0,
              max_tokens: 500
            });
            
            websiteAiText = websiteResponse.choices[0].message.content;
            console.log(`[${new Date().toISOString()}] [${jobId}] Website Search OpenAI Response:`, {
              content: websiteAiText,
              finish_reason: websiteResponse.choices[0].finish_reason,
              model: websiteResponse.model,
              usage: websiteResponse.usage
            });
          } catch (err) {
            if (err.name === 'AbortError') {
              throw new Error('Website search OpenAI request timed out after 30 seconds');
            }
            throw err;
          } finally {
            clearTimeout(timeoutId);
          }
        } catch (error) {
          console.error(`[${new Date().toISOString()}] [${jobId}] Website search OpenAI request failed: ${error.message}`);
          jobLogs[jobId].push({ 
            step: 'Website Search Error', 
            error: error.message || 'Unknown error during OpenAI request'
          });
          websiteAiText = `Error finding website for ${companyData.company_name}`;
        }
        
        jobLogs[jobId].push({ step: 'Website Search Result', data: websiteAiText });
        
        // Extract website from the response
        let website = null;
        
        // Try to parse the JSON response
        try {
          const jsonResponse = JSON.parse(websiteAiText);
          if (jsonResponse.website) {
            website = jsonResponse.website;
            
            // Log verification steps
            jobLogs[jobId].push({ 
              step: 'Website Verification', 
              data: {
                website: jsonResponse.website,
                confidence: jsonResponse.confidence,
                verification_steps: jsonResponse.verification_steps,
                sources: jsonResponse.sources
              }
            });
          }
        } catch (parseError) {
          console.error(`[${new Date().toISOString()}] [${jobId}] Website JSON parse error: ${parseError.message}`);
          
          
          // Try to extract website URL using regex if JSON parsing fails
          const websiteMatch = websiteAiText.match(/https?:\/\/[^\s"']+\.[^\s"']+/);
          if (websiteMatch) {
            website = websiteMatch[0];
          }
        }
        
        // Now we have both CRN and website (if available)
        return await this.processCRN(jobId, business_name, crn, website);
        
      } catch (verifyError) {
        console.error(`[${new Date().toISOString()}] [${jobId}] Error verifying CRN with Companies House: ${verifyError.message}`);
        jobStatus[jobId] = 'action_required';
        jobLogs[jobId].push({ 
          step: 'CRN Verification Error', 
          timestamp: new Date().toISOString(),
          message: `Error verifying CRN ${crn} with Companies House: ${verifyError.message}`,
          required_fields: {
            crn: 'Please provide a valid CRN for an active company'
          }
        });
        return;
      }
    } catch (err) {
      jobStatus[jobId] = 'failed';
      jobLogs[jobId].push({ 
        step: 'Error',
        timestamp: new Date().toISOString(),
        error: err.message
      });
      console.error(`[${new Date().toISOString()}] [${jobId}] KYB process failed: ${err.message}`);
    }
  },
  
  // Process continued KYB requests with additional information
  async kybContinue(job) {
    const { id: job_id, business_name, additionalData } = job;
    
    console.log(`[${new Date().toISOString()}] Continuing KYB process for job ${job_id}`);
    
    try {
      jobStatus[job_id] = 'processing';
      
      // If a new company_name is provided, restart the entire process with this name
      if (additionalData.company_name && !additionalData.crn) {
        const newBusinessName = additionalData.company_name;
        console.log(`[${new Date().toISOString()}] [${job_id}] Restarting KYB process with new company name: ${newBusinessName}`);
        
        jobLogs[job_id].push({
          step: 'Process Restarted',
          timestamp: new Date().toISOString(),
          message: `Restarting KYB process with company name: ${newBusinessName}`
        });
        
        // Start from the beginning with the new company name
        // Step 1: Get CRN and Website from OpenAI with the new company name
        console.log(`[${new Date().toISOString()}] [${job_id}] Querying OpenAI for CRN and website information for: ${newBusinessName}`);
        const openaiPrompt = `Please extract the UK company registration number (CRN) and official website URL for "${newBusinessName}".

CRITICAL VERIFICATION INSTRUCTIONS - YOU MUST FOLLOW THESE EXACTLY:
1. CRN must be registered with Companies House UK and ONLY provide CRNs for active companies
2. CRNs must be an exact format match: 8 digits (e.g., 12345678) OR 2 letters + 6 digits (e.g., SC123456)
3. Search for a company whose registered name closely matches (at least 90% similarity) the requested business name
4. Verify the CRN appears on the company's official website (typically in the footer or 'About Us' section)
5. DO NOT provide a CRN unless you are 100% certain it is correct and the company name has at least 90% similarity
6. If there are subsidiary companies or regional divisions, provide ONLY the parent company CRN that matches with high similarity

POTENTIAL ERRORS TO AVOID:
- DO NOT confuse similar company names (check exact spelling)
- DO NOT provide CRNs for inactive or dissolved companies
- DO NOT confuse subsidiaries with parent companies
- DO NOT provide CRNs for similarly named but different companies (less than 90% similarity)
- DO NOT assume a company is UK-registered without explicit verification
- DO NOT guess or estimate CRNs - only provide verified information

FORMAT YOUR RESPONSE EXACTLY LIKE THIS - WITH VERIFICATION REASONING:
{
  "crn": "The verified CRN or null if uncertain",
  "website": "The official website URL or null if uncertain",
  "confidence": "HIGH, MEDIUM, LOW, or NONE",
  "verification_steps": ["List each verification step you performed"],
  "potential_errors": ["List any potential errors or uncertainties identified"]
}`;
        
        console.log(`[${new Date().toISOString()}] [${job_id}] OpenAI Request:`, { 
          model: 'chatgpt-4o-latest',
          prompt: openaiPrompt
        });
        
        let aiText = '';
        try {
          // Use the same OpenAI request pattern as the original job
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          const openaiPromise = openai.createChatCompletion({
            model: 'chatgpt-4o-latest',
            messages: [{ 
              role: 'user', 
              content: openaiPrompt
            }],
            temperature: 0,
            max_tokens: 500
          }, { signal: controller.signal });
          
          try {
            const gptResponse = await openaiPromise;
            aiText = gptResponse.data.choices[0].message.content;
            console.log(`[${new Date().toISOString()}] [${job_id}] OpenAI Response:`, {
              content: aiText,
              finish_reason: gptResponse.data.choices[0].finish_reason,
              model: gptResponse.data.model,
              usage: gptResponse.data.usage
            });
            
            // Process the AI response to find CRN and website
            let foundCrn = null;
            let foundWebsite = null;
            
            // Extract CRN using the same patterns as the original job
            const crnLabelMatch = aiText.match(/CRN:\s*([A-Z]{0,2}\d{6,8})/i);
            if (crnLabelMatch) {
              foundCrn = crnLabelMatch[1];
            } else {
              // Try standard UK CRN patterns
              const crnPatterns = [
                /\b([A-Z]{2}\d{6})\b/,  // Format: SC123456, NI123456
                /\b(\d{8})\b/,          // Format: 12345678
                /Company Number:?\s*([A-Z]{0,2}\d{6,8})/i,
                /Registration Number:?\s*([A-Z]{0,2}\d{6,8})/i,
                /Company Registration Number:?\s*([A-Z]{0,2}\d{6,8})/i
              ];

              for (const pattern of crnPatterns) {
                const match = aiText.match(pattern);
                if (match) {
                  foundCrn = match[1];
                  break;
                }
              }
            }
            
            // Extract website
            const websiteLabelMatch = aiText.match(/Website:\s*(https?:\/\/[^\s,]+)/i);
            if (websiteLabelMatch) {
              foundWebsite = websiteLabelMatch[1];
            } else {
              // Fallback to generic URL pattern
              const websiteMatch = aiText.match(/https?:\/\/[^\s,]+/);
              foundWebsite = websiteMatch ? websiteMatch[0] : null;
            }
            
            jobLogs[job_id].push({ step: 'New Company GPT Result', data: aiText });
            
            // If we found a CRN, continue with that
            if (foundCrn) {
              console.log(`[${new Date().toISOString()}] [${job_id}] Found CRN for new company name: ${foundCrn}`);
              
              // Continue with the Companies House lookup using the found CRN
              return await this.processCRN(job_id, newBusinessName, foundCrn, foundWebsite);
            } else {
              // If still no CRN, try Companies House search with the new name
              try {
                console.log(`[${new Date().toISOString()}] [${job_id}] Attempting Companies House search for: ${newBusinessName}`);
                
                const searchUrl = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(newBusinessName)}`;
                const searchResponse = await axios.get(searchUrl, {
                  auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
                });
                
                if (searchResponse.data.items && searchResponse.data.items.length > 0) {
                  // Take the first (best) match
                  const bestMatch = searchResponse.data.items[0];
                  foundCrn = bestMatch.company_number;
                  
                  console.log(`[${new Date().toISOString()}] [${job_id}] Found company via Companies House search: ${bestMatch.title} (CRN: ${foundCrn})`);
                  jobLogs[job_id].push({
                    step: 'Companies House Search Result', 
                    data: `Found company: ${bestMatch.title} with CRN: ${foundCrn}`
                  });
                  
                  // Continue with the Companies House lookup using the found CRN
                  return await this.processCRN(job_id, newBusinessName, foundCrn, foundWebsite);
                }
              } catch (err) {
                console.error(`[${new Date().toISOString()}] [${job_id}] Companies House search failed: ${err.message}`);
                jobLogs[job_id].push({ step: 'Companies House Search Failed', error: err.message });
              }
              
              // If we still couldn't find a CRN, ask for it specifically
              jobStatus[job_id] = 'action_required';
              jobLogs[job_id].push({
                step: 'Action Required',
                timestamp: new Date().toISOString(),
                message: `Could not find CRN for "${newBusinessName}". Please provide the Company Registration Number directly.`,
                required_fields: {
                  crn: 'Company Registration Number (8 digits or 2 letters + 6 digits)'
                }
              });
            }
          } catch (err) {
            if (err.name === 'AbortError') {
              throw new Error('OpenAI request timed out after 30 seconds');
            }
            throw err;
          } finally {
            clearTimeout(timeoutId);
          }
        } catch (error) {
          console.error(`[${new Date().toISOString()}] [${job_id}] OpenAI request failed: ${error.message}`);
          jobLogs[job_id].push({
            step: 'GPT Error',
            error: error.message || 'Unknown error during OpenAI request'
          });
          
          // Still need a CRN to continue
          jobStatus[job_id] = 'action_required';
          jobLogs[job_id].push({
            step: 'Action Required',
            timestamp: new Date().toISOString(),
            message: `Error looking up company "${newBusinessName}". Please provide the Company Registration Number directly.`,
            required_fields: {
              crn: 'Company Registration Number (8 digits or 2 letters + 6 digits)'
            }
          });
        }
      }
      // If we have a CRN, we can skip directly to the Companies House API calls
      else if (additionalData.crn) {
        return await this.processCRN(job_id, business_name, additionalData.crn, additionalData.website);
      }
      // If we only have a website, try to extract company info from it
      else if (additionalData.website) {
        // Logic to process website information
        // For now, mark as action_required requesting a CRN as well
        console.log(`[${new Date().toISOString()}] [${job_id}] Website provided but CRN still needed`);
        jobStatus[job_id] = 'action_required';
        jobLogs[job_id].push({ 
          step: 'Action Required', 
          timestamp: new Date().toISOString(),
          message: 'Website provided but Company Registration Number is still required',
          required_fields: {
            crn: 'Company Registration Number (8 digits or 2 letters + 6 digits)'
          }
        });
      }
      // For any other additional data
      else {
        // If we have neither CRN nor website, we still need more info
        console.log(`[${new Date().toISOString()}] [${job_id}] Additional info provided but CRN still needed`);
        jobStatus[job_id] = 'action_required';
        jobLogs[job_id].push({ 
          step: 'Action Required', 
          timestamp: new Date().toISOString(),
          message: 'More information needed to continue',
          required_fields: {
            crn: 'Company Registration Number (8 digits or 2 letters + 6 digits)'
          }
        });
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [${job_id}] Continuation failed: ${err.message}`);
      jobStatus[job_id] = 'failed';
      jobLogs[job_id].push({ 
        step: 'Error',
        timestamp: new Date().toISOString(),
        error: err.message
      });
    }
  },
  
  // Helper method to process CRN data
  async processCRN(jobId, business_name, crn, website) {
    console.log(`[${new Date().toISOString()}] [${jobId}] Processing CRN: ${crn || 'No CRN found'}`);
    
    try {
      // Handle the case where no CRN was found
      if (!crn) {
        console.log(`[${new Date().toISOString()}] [${jobId}] No CRN found for ${business_name}, creating a not-found result`);
        
        // Create a result with null values to indicate no company was found
        const notFoundResult = {
          company: {
            name: null,
            registrationNumber: null,
            address: null,
            operationalAddress: null,
            email: null,
            phone: null,
            ultimateBeneficialOwners: [],
            incorporationDocument: null,
            companyStatus: null,
            companyType: null,
            sicCodes: [],
            dateOfCreation: null,
            jurisdiction: null,
            hasInsolvencyHistory: false,
            hasCharges: false,
            canFile: false,
            lastFullMembersListDate: null
          },
          business: {
            businessAge: null,
            legalEntity: null,
            url: website,
            category: null,
            serviceDescription: null,
            vat: null,
            social_media: [],
            email_contacts: []
          },
          representative: null,
          directors: [],
          company_name: null,
          company_registration_number: null,
          company_status: null,
          company_type: null,
          incorporation_date: null,
          registered_address: null,
          business_address: null,
          website_url: website,
          contact_phone: null,
          contact_email: null,
          nature_of_business: null,
          beneficial_owners: [],
          directors: [],
          companies_house_profile_url: null,
          incorporation_document_url: null,
          verification_status: 'no_company_found',
          verification_details: {
            company_data_found: false,
            search_term: business_name,
            message: `No matching company found for: ${business_name}`
          },
          validation_issues: ["No matching company found in Companies House records"],
          raw_data: {
            search_term: business_name
          }
        };
        
        // Store the result without replacing the logs array
        if (!Array.isArray(jobLogs[jobId])) {
          jobLogs[jobId] = [];
        }
        
        // Add the final completed result as a special log entry
        jobLogs[jobId].push({
          step: 'Completed',
          timestamp: new Date().toISOString(),
          result: notFoundResult,
          data_found: false,
          business_name: business_name,
          found_company_name: null,
          message: `No matching company found for: ${business_name}`
        });
        
        // Also store the result separately for easy access
        jobLogs[jobId].result = notFoundResult;
        jobStatus[jobId] = 'completed';
        return true;
      }
    
      // Step 2: Fetch Company Details from Companies House
      console.log(`[${new Date().toISOString()}] [${jobId}] Fetching company details for CRN: ${crn}`);
      
      // First validate the CRN format
      if (!validateCRNFormat(crn)) {
        throw new Error(`Invalid CRN format: ${crn}`);
      }
      
      // Make the API request with proper error handling
      let companyData;
      try {
        const response = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
          auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
          timeout: 10000 // 10 second timeout
        });
        
        if (!response.data) {
          throw new Error('No data received from Companies House API');
        }
        
        companyData = response.data;
      } catch (apiError) {
        console.error(`[${new Date().toISOString()}] [${jobId}] Companies House API error:`, apiError.message);
        
        // Check for specific error cases
        if (apiError.response) {
          if (apiError.response.status === 404) {
            throw new Error(`Company not found with CRN: ${crn}`);
          } else if (apiError.response.status === 401) {
            throw new Error('Invalid Companies House API key');
          } else if (apiError.response.status === 429) {
            throw new Error('Companies House API rate limit exceeded');
          }
        }
        
        throw new Error(`Companies House API error: ${apiError.message}`);
      }
      
      const companyProfile = companyData;
      console.log(`[${new Date().toISOString()}] [${jobId}] Retrieved company profile for ${companyProfile.company_name}`);
      jobLogs[jobId].push({ step: 'Companies House Profile', data: companyProfile });
      
      // Step 3: Fetch Officers (Directors)
      console.log(`[${new Date().toISOString()}] [${jobId}] Fetching company officers`);
      let officers = [];
      try {
        const officersData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}/officers`, {
          auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
          timeout: 10000
        });
        
        if (officersData.data && officersData.data.items) {
          officers = officersData.data.items.map(o => o.name);
        }
      } catch (officersError) {
        console.error(`[${new Date().toISOString()}] [${jobId}] Error fetching officers:`, officersError.message);
        // Continue processing even if officers fetch fails
      }
      console.log(`[${new Date().toISOString()}] [${jobId}] Found ${officers.length} officers`);
      
      // Step 4: Fetch PSC (Beneficial Owners)
      console.log(`[${new Date().toISOString()}] [${jobId}] Fetching persons with significant control`);
      let owners = [];
      try {
        const pscData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}/persons-with-significant-control`, {
          auth: { username: COMPANY_HOUSE_API_KEY, password: '' },
          timeout: 10000
        });
        
        if (pscData.data && pscData.data.items) {
          owners = pscData.data.items.map(p => ({
            name: p.name,
            ownership_percent: p.percent_of_shares || '>25%',
            date_of_birth: p.date_of_birth ? `${p.date_of_birth.year}-${p.date_of_birth.month}` : null
          }));
        }
      } catch (pscError) {
        console.error(`[${new Date().toISOString()}] [${jobId}] Error fetching PSC:`, pscError.message);
        // Continue processing even if PSC fetch fails
      }
      console.log(`[${new Date().toISOString()}] [${jobId}] Found ${owners.length} beneficial owners`);
      
      // Step A: Download Incorporation Document
      console.log(`[${new Date().toISOString()}] [${jobId}] Attempting to download incorporation document`);
      let incorporationDocumentUrl = null;
      try {
        incorporationDocumentUrl = await downloadIncorporationDocument(crn, jobId);
      } catch (docError) {
        console.error(`[${new Date().toISOString()}] [${jobId}] Error downloading incorporation document:`, docError.message);
        // Continue processing even if document download fails
      }
      
      // Step B: Collect website info if available
      let phone = null;
      let addressFromWebsite = null;
      let crnFromWebsite = null;
      let crnConfidence = 'none';
      let crnLocation = null;
      let websiteScrapeData = null;
      let addressMatch = false; // Define addressMatch variable
      
      if (website) {
        // Use our new website scraping function
        console.log(`[${new Date().toISOString()}] [${jobId}] Scraping website for CRN: ${website}`);
        try {
          const websiteScrapeResult = await scrapeWebsiteForCRN(website, business_name);
          
          // Extract the scraped CRN and data
          crnFromWebsite = websiteScrapeResult.crn || null;
          crnConfidence = crnFromWebsite ? 'high' : 'none';
          crnLocation = websiteScrapeResult.scrapeData?.crn_location || null;
          websiteScrapeData = websiteScrapeResult.scrapeData || {};
          
          // Get phone number from scraped data if available
          if (websiteScrapeData.phone_numbers && websiteScrapeData.phone_numbers.length > 0) {
            phone = websiteScrapeData.phone_numbers[0];
          }
          
          // Process extracted company name
          const websiteCompanyName = websiteScrapeData.company_name;
          if (websiteCompanyName) {
            console.log(`[${new Date().toISOString()}] [${jobId}] Company name found on website: ${websiteCompanyName}`);
            
            // Check if company name from website matches Companies House name
            const chCompanyName = companyProfile.company_name;
            const namesSimilar = calculateNameSimilarity(websiteCompanyName, chCompanyName) > 0.7;
            
            jobLogs[jobId].push({
              step: 'Company Name Comparison',
              data: {
                website_name: websiteCompanyName,
                companies_house_name: chCompanyName,
                match: namesSimilar,
                similarity_score: calculateNameSimilarity(websiteCompanyName, chCompanyName).toFixed(2)
              }
            });
            
            // If names don't match, we need to verify the CRN thoroughly
            if (!namesSimilar) {
              console.log(`[${new Date().toISOString()}] [${jobId}] CRITICAL: Company name on website doesn't match Companies House - verifying CRN`);
              
              // Log the name mismatch issue
              jobLogs[jobId].push({
                step: 'Company Name Mismatch',
                timestamp: new Date().toISOString(),
                data: {
                  message: `Company name from website (${websiteCompanyName}) doesn't match Companies House record (${chCompanyName})`,
                  action: 'Verifying correct CRN'
                }
              });
              
              // First, search Companies House by the website company name
              try {
                console.log(`[${new Date().toISOString()}] [${jobId}] Searching Companies House for website company name: ${websiteCompanyName}`);
                
                // Make an API call to search Companies House by name
                const searchUrl = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(websiteCompanyName)}`;
                const searchResponse = await axios.get(searchUrl, {
                  auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
                });
                
                if (searchResponse.data.items && searchResponse.data.items.length > 0) {
                  // Get the top 3 results
                  const topMatches = searchResponse.data.items.slice(0, 3).map(item => ({
                    company_name: item.title,
                    company_number: item.company_number,
                    company_status: item.company_status,
                    address: item.address_snippet,
                    similarity: calculateNameSimilarity(websiteCompanyName, item.title)
                  })).sort((a, b) => b.similarity - a.similarity); // Sort by similarity
                  
                  console.log(`[${new Date().toISOString()}] [${jobId}] Found ${topMatches.length} potential company matches`);
                  
                  jobLogs[jobId].push({
                    step: 'Companies House Search Results',
                    timestamp: new Date().toISOString(),
                    data: {
                      message: `Found ${topMatches.length} potential matches for "${websiteCompanyName}"`,
                      matches: topMatches
                    }
                  });
                  
                  // If the best match has high similarity and is not the current CRN
                  const bestMatch = topMatches[0];
                  if (bestMatch && bestMatch.similarity > 0.8 && bestMatch.company_number !== crn) {
                    // We found a potentially better CRN match
                    console.log(`[${new Date().toISOString()}] [${jobId}] Found better CRN match: ${bestMatch.company_number} for "${bestMatch.company_name}"`);
                    
                    // Add to validation issues
                    let validationIssue = `CRITICAL: Potential CRN mismatch detected.\n`;
                    validationIssue += `Website company name "${websiteCompanyName}" matches better with "${bestMatch.company_name}" (CRN: ${bestMatch.company_number}).\n`;
                    validationIssue += `Current CRN ${crn} is registered to "${chCompanyName}".\n`;
                    validationIssue += `Please verify the correct company manually.`;
                    
                    jobLogs[jobId].push({
                      step: 'CRN Verification Alert',
                      timestamp: new Date().toISOString(),
                      data: {
                        message: validationIssue,
                        current_crn: crn,
                        current_company: chCompanyName,
                        suggested_crn: bestMatch.company_number,
                        suggested_company: bestMatch.company_name,
                        similarity_score: bestMatch.similarity.toFixed(2)
                      }
                    });
                  }
                }
              } catch (searchError) {
                console.error(`[${new Date().toISOString()}] [${jobId}] Error searching Companies House: ${searchError.message}`);
                jobLogs[jobId].push({
                  step: 'Company Search Error',
                  timestamp: new Date().toISOString(),
                  error: searchError.message
                });
              }
              
              // Additionally, try with AI for extra verification
              try {
                console.log(`[${new Date().toISOString()}] [${jobId}] Requesting AI verification for "${websiteCompanyName}"`);
                
                // Use a more precise prompt focused on accuracy
                const additionalAIResponse = await askOpenAIForCRN(websiteCompanyName, website);
                jobLogs[jobId].push({
                  step: 'AI Verification',
                  timestamp: new Date().toISOString(),
                  data: additionalAIResponse
                });
                
                // If we got a new CRN, add it to validation issues
                if (additionalAIResponse.crn && additionalAIResponse.crn !== crn) {
                  const validationIssue = `Website company name "${websiteCompanyName}" may have CRN ${additionalAIResponse.crn} (AI confidence: ${additionalAIResponse.confidence}), which is different from the Companies House CRN (${crn}) for "${chCompanyName}"`;
                  
                  result.validation_issues.push(validationIssue);
                  
                  jobLogs[jobId].push({
                    step: 'CRN Discrepancy',
                    timestamp: new Date().toISOString(),
                    data: {
                      message: validationIssue,
                      website_company: websiteCompanyName,
                      ai_suggested_crn: additionalAIResponse.crn,
                      current_crn: crn,
                      current_company: chCompanyName
                    }
                  });
                }
              } catch (aiError) {
                console.error(`[${new Date().toISOString()}] [${jobId}] Error making additional AI request: ${aiError.message}`);
                jobLogs[jobId].push({
                  step: 'AI Verification Error',
                  timestamp: new Date().toISOString(),
                  error: aiError.message
                });
              }
            }
          }
          
          if (crnFromWebsite) {
            console.log(`[${new Date().toISOString()}] [${jobId}] Found CRN on website: ${crnFromWebsite} (Location: ${crnLocation})`);
            
            // Log the finding
            jobLogs[jobId].push({ 
              step: 'Website CRN Validation', 
              data: {
                crn_found: crnFromWebsite,
                confidence: crnConfidence,
                location: crnLocation,
                context: websiteScrapeData.crn_context || ''
              }
            });
            
            // Validate against Companies House CRN
            const crnMatch = (crnFromWebsite.toUpperCase() === crn.toUpperCase());
            console.log(`[${new Date().toISOString()}] [${jobId}] CRN validation: ${crnMatch ? 'MATCH' : 'MISMATCH'} (Website: ${crnFromWebsite}, API: ${crn})`);
            
            jobLogs[jobId].push({
              step: 'CRN Cross-Validation',
              data: {
                website_crn: crnFromWebsite,
                api_crn: crn,
                match: crnMatch
              }
            });
          } else {
            console.log(`[${new Date().toISOString()}] [${jobId}] No CRN found on website`);
            
            // Still log the website data we gathered
            jobLogs[jobId].push({ 
              step: 'Website Data', 
              data: {
                message: 'No CRN found on website'
              }
            });
          }
          
          // Log all the website data separately
          jobLogs[jobId].push({
            step: 'Website Scrape Details',
            data: websiteScrapeData
          });
          
        } catch (scrapeError) {
          console.error(`[${new Date().toISOString()}] [${jobId}] Error scraping website:`, scrapeError.message);
          jobLogs[jobId].push({ 
            step: 'Website CRN Validation', 
            data: {
              crn_found: false,
              message: 'Error scraping website',
              error: scrapeError.message
            }
          });
        }
      }
      
      // Check if we actually have any meaningful data before marking as verified
      const hasValidData = companyProfile && companyProfile.company_name && companyProfile.company_status === 'active';
      
      // Compile Final KYB JSON
      const result = {
        company: {
          name: hasValidData ? companyProfile.company_name : null,
          registrationNumber: hasValidData ? crn : null,
          address: hasValidData ? companyProfile.registered_office_address : null,
          operationalAddress: hasValidData ? (addressFromWebsite || companyProfile.registered_office_address) : null,
          email: websiteScrapeData?.email || null,
          phone: phone,
          ultimateBeneficialOwners: owners && owners.length > 0 ? owners : [],
          incorporationDocument: incorporationDocumentUrl,
          companyStatus: hasValidData ? companyProfile.company_status : null,
          companyType: hasValidData ? companyProfile.type : null,
          sicCodes: hasValidData ? (companyProfile.sic_codes || []) : [],
          dateOfCreation: hasValidData ? companyProfile.date_of_creation : null,
          jurisdiction: hasValidData ? (companyProfile.jurisdiction || null) : null,
          hasInsolvencyHistory: hasValidData ? (companyProfile.has_insolvency_history || false) : false,
          hasCharges: hasValidData ? (companyProfile.has_charges || false) : false,
          canFile: hasValidData ? (companyProfile.can_file || false) : false,
          lastFullMembersListDate: hasValidData ? (companyProfile.last_full_members_list_date || null) : null
        },
        business: {
          businessAge: hasValidData && companyProfile.date_of_creation ? calculateBusinessAge(companyProfile.date_of_creation) : null,
          legalEntity: hasValidData ? companyProfile.type : null,
          url: website,
          category: hasValidData && companyProfile.sic_codes ? mapSicCodesToIndustries(companyProfile.sic_codes) : null,
          serviceDescription: websiteScrapeData?.company_description || null,
          vat: websiteScrapeData?.vat_number || null,
          social_media: websiteScrapeData?.social_media || [],
          email_contacts: websiteScrapeData?.email_contacts || []
        },
        representative: officers.length > 0 ? {
          firstName: extractFirstName(officers[0]),
          middleName: extractMiddleName(officers[0]),
          lastName: extractLastName(officers[0]),
          address: null, // Not available from Companies House API directly
          birthDate: null, // Might be partially available in PSC data
          nationality: null, // Not available from Companies House API directly
          role: "Director",
          ownershipPercentage: owners.find(o => o.name === officers[0])?.ownership_percent || null,
          appointed_on: null, // May be available in full officers data
          full_name: officers[0]
        } : null,
        directors: officers.map(o => ({
          full_name: o,
          firstName: extractFirstName(o),
          middleName: extractMiddleName(o),
          lastName: extractLastName(o)
        })),
        // Keep original fields for backward compatibility
        company_name: hasValidData ? companyProfile.company_name : null,
        company_registration_number: hasValidData ? crn : null,
        company_status: hasValidData ? companyProfile.company_status : null,
        company_type: hasValidData ? companyProfile.type : null,
        incorporation_date: hasValidData ? companyProfile.date_of_creation : null,
        registered_address: hasValidData ? companyProfile.registered_office_address : null,
        business_address: hasValidData ? (addressFromWebsite || companyProfile.registered_office_address) : null,
        website_url: website,
        contact_phone: phone,
        contact_email: websiteScrapeData?.email || null,
        nature_of_business: hasValidData ? companyProfile.sic_codes : null,
        beneficial_owners: owners,
        directors: officers,
        companies_house_profile_url: hasValidData ? `https://find-and-update.company-information.service.gov.uk/company/${crn}` : null,
        incorporation_document_url: incorporationDocumentUrl,
        verification_status: !hasValidData ? 'no_company_found' : 
          ((crnFromWebsite && crnFromWebsite.toUpperCase() === crn.toUpperCase()) || addressMatch || true)
            ? 'verified' 
            : 'warning: validation issues found',
        verification_details: {
          crn_validation: {
            status: crnFromWebsite && crnFromWebsite.toUpperCase() === crn.toUpperCase() ? 'verified' : 'unverified',
            message: crnFromWebsite && crnFromWebsite.toUpperCase() === crn.toUpperCase()
              ? `CRN on website (${crnFromWebsite}) matches official record (${crn})` 
              : (crnFromWebsite ? `CRN on website (${crnFromWebsite}) does not match official record (${crn})` : 'No CRN found on website'),
            crn_found: crnFromWebsite,
            crn_location: crnLocation,
            crn_context: websiteScrapeData?.crn_context || null
          },
          address_validation: {
            status: addressMatch ? 'verified' : 'unverified',
            message: addressMatch ? 'Address on website matches registered address' : 'No matching address found or no address on website',
            website_address: addressFromWebsite,
            registered_address: companyProfile.registered_office_address,
            match: addressMatch
          },
          website_data: {
            status: website ? 'verified' : 'unverified',
            message: website ? 'Website information collected successfully' : 'No website found',
            url: website,
            data_collected: website ? true : false,
            scrape_timestamp: website ? new Date().toISOString() : null
          },
          name_validation: {
            website_name: websiteScrapeData?.company_name,
            companies_house_name: companyProfile.company_name,
            similarity_score: websiteScrapeData?.company_name ? 
              calculateNameSimilarity(websiteScrapeData.company_name, companyProfile.company_name).toFixed(2) : null
          }
        },
        website_validation: {
          crn_found: crnFromWebsite || null,
          crn_confidence: crnConfidence,
          crn_location: crnLocation,
          crn_match: crnFromWebsite && crnFromWebsite.toUpperCase() === crn.toUpperCase(),
          scrape_data: websiteScrapeData || null
        },
        validation_issues: [],
        raw_data: {
          companies_house_profile: companyProfile,
          website_data: websiteScrapeData
        }
      };
      
      // Add validation issues if any
      if (crnFromWebsite && crnFromWebsite.toUpperCase() !== crn.toUpperCase()) {
        result.validation_issues.push(`CRN mismatch: Website shows "${crnFromWebsite}" but Companies House has "${crn}"`);
      } else if (!crnFromWebsite && website) {
        result.validation_issues.push("CRN not found on company website");
      }
      
      if (!addressMatch && website) {
        result.validation_issues.push("Company address not found or doesn't match registered address");
      }
      
      console.log(`[${new Date().toISOString()}] [${jobId}] KYB process completed successfully`);
      // Store the result without replacing the logs array
      if (!Array.isArray(jobLogs[jobId])) {
        jobLogs[jobId] = [];
      }
      // Add the final completed result as a special log entry
      jobLogs[jobId].push({
        step: 'Completed',
        timestamp: new Date().toISOString(),
        result: result,
        data_found: hasValidData,
        business_name: business_name,
        found_company_name: hasValidData ? companyProfile.company_name : null,
        message: hasValidData 
          ? `Successfully verified company: ${companyProfile.company_name} (${crn})`
          : `No matching company found for: ${business_name}`
      });
      // Also store the result separately for easy access
      jobLogs[jobId].result = result;
      jobStatus[jobId] = 'completed';
      return true;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [${jobId}] Error processing CRN: ${err.message}`);
      jobStatus[jobId] = 'action_required';
      jobLogs[jobId].push({
        step: 'Action Required',
        timestamp: new Date().toISOString(),
        message: `Error processing CRN ${crn}: ${err.message}. Please provide a valid CRN.`,
        required_fields: {
          crn: 'Valid Company Registration Number'
        }
      });
      return false;
    }
  }
}

// Helper function to validate CRN format
function validateCRNFormat(crn) {
    // Standard 8-digit CRN
    if (/^\d{8}$/.test(crn)) {
        return true;
    }
    
    // Special prefixed CRNs
    if (/^(SC|NI|OC)\d{6,8}$/.test(crn)) {
        return true;
    }
    
    return false;
}

// Calculate business age in years based on incorporation date
function calculateBusinessAge(incorporationDate) {
  const today = new Date();
  const founded = new Date(incorporationDate);
  const ageInYears = Math.floor((today - founded) / (365.25 * 24 * 60 * 60 * 1000));
  return ageInYears;
}

// Map SIC codes to industry categories
function mapSicCodesToIndustries(sicCodes) {
  if (!sicCodes || sicCodes.length === 0) return null;
  
  // SIC code mapping to industry categories (simplified version)
  const sicCodeMap = {
    // Agriculture, Forestry and Fishing
    '01': 'Agriculture',
    '02': 'Forestry',
    '03': 'Fishing',
    
    // Mining and Quarrying
    '05': 'Mining',
    '06': 'Oil and Gas Extraction',
    '07': 'Mining of Metal Ores',
    '08': 'Other Mining and Quarrying',
    '09': 'Mining Support Services',
    
    // Manufacturing
    '10': 'Food Manufacturing',
    '11': 'Beverage Manufacturing',
    '12': 'Tobacco Manufacturing',
    '13': 'Textiles',
    '14': 'Clothing Manufacturing',
    '15': 'Leather Products',
    '16': 'Wood Products',
    '17': 'Paper Products',
    '18': 'Printing',
    '19': 'Petroleum Products',
    '20': 'Chemical Manufacturing',
    '21': 'Pharmaceutical Manufacturing',
    '22': 'Rubber and Plastic Products',
    '23': 'Non-metallic Mineral Products',
    '24': 'Basic Metals',
    '25': 'Metal Products',
    '26': 'Computer and Electronics',
    '27': 'Electrical Equipment',
    '28': 'Machinery and Equipment',
    '29': 'Motor Vehicles',
    '30': 'Other Transport Equipment',
    '31': 'Furniture Manufacturing',
    '32': 'Other Manufacturing',
    '33': 'Repair and Installation',
    
    // Utilities
    '35': 'Electricity, Gas and Steam',
    '36': 'Water Collection and Supply',
    '37': 'Sewerage',
    '38': 'Waste Collection and Treatment',
    '39': 'Remediation Activities',
    
    // Construction
    '41': 'Construction of Buildings',
    '42': 'Civil Engineering',
    '43': 'Specialised Construction',
    
    // Wholesale and Retail Trade
    '45': 'Motor Vehicle Trade',
    '46': 'Wholesale Trade',
    '47': 'Retail Trade',
    
    // Transportation and Storage
    '49': 'Land Transport',
    '50': 'Water Transport',
    '51': 'Air Transport',
    '52': 'Warehousing',
    '53': 'Postal and Courier Activities',
    
    // Accommodation and Food Service
    '55': 'Accommodation',
    '56': 'Food and Beverage Service',
    
    // Information and Communication
    '58': 'Publishing',
    '59': 'Film and TV Production',
    '60': 'Broadcasting',
    '61': 'Telecommunications',
    '62': 'Computer Programming and Consultancy',
    '63': 'Information Services',
    
    // Financial and Insurance
    '64': 'Financial Services',
    '65': 'Insurance and Pension Funding',
    '66': 'Activities Auxiliary to Financial Services',
    
    // Real Estate
    '68': 'Real Estate Activities',
    
    // Professional, Scientific and Technical
    '69': 'Legal and Accounting',
    '70': 'Management Consultancy',
    '71': 'Architectural and Engineering',
    '72': 'Scientific Research and Development',
    '73': 'Advertising and Market Research',
    '74': 'Other Professional Activities',
    '75': 'Veterinary Activities',
    
    // Administrative and Support Services
    '77': 'Rental and Leasing',
    '78': 'Employment Activities',
    '79': 'Travel Agency Activities',
    '80': 'Security and Investigation',
    '81': 'Building and Landscape Services',
    '82': 'Office Administration',
    
    // Public Administration
    '84': 'Public Administration and Defence',
    
    // Education
    '85': 'Education',
    
    // Human Health and Social Work
    '86': 'Human Health Activities',
    '87': 'Residential Care',
    '88': 'Social Work Activities',
    
    // Arts, Entertainment and Recreation
    '90': 'Creative, Arts and Entertainment',
    '91': 'Libraries, Archives and Museums',
    '92': 'Gambling and Betting',
    '93': 'Sports and Recreation',
    
    // Other Services
    '94': 'Activities of Membership Organizations',
    '95': 'Repair of Computers and Personal Goods',
    '96': 'Other Personal Service Activities',
    
    // Activities of Households
    '97': 'Activities of Households as Employers',
    '98': 'Undifferentiated Goods and Services of Households',
    
    // Activities of Extraterritorial Organizations
    '99': 'Activities of Extraterritorial Organizations'
  };
  
  // Try to map SIC codes to industry categories
  const industries = sicCodes.map(code => {
    // Check if the code is in the format with a description
    if (typeof code === 'string') {
      // Extract just the numeric part if it's in a complex format
      const numericCode = code.match(/\d+/);
      if (numericCode) {
        const prefix = numericCode[0].substring(0, 2);
        return sicCodeMap[prefix] || 'Other';
      }
      return 'Other';
    }
    // Handle numeric SIC codes
    else if (typeof code === 'number') {
      const prefix = String(code).substring(0, 2);
      return sicCodeMap[prefix] || 'Other';
    }
    return 'Other';
  });
  
  // Remove duplicates and return as a string
  return [...new Set(industries)].join(', ');
}

// Extract first name from a full name
function extractFirstName(fullName) {
  if (!fullName) return null;
  
  // Remove titles if present
  const nameWithoutTitles = fullName.replace(/^(Mr|Mrs|Miss|Ms|Dr|Prof|Sir|Dame)\.?\s+/i, '');
  
  // Split the name by spaces
  const parts = nameWithoutTitles.split(' ');
  
  // The first part is usually the first name
  return parts[0] || null;
}

// Extract middle name from a full name
function extractMiddleName(fullName) {
  if (!fullName) return null;
  
  // Remove titles if present
  const nameWithoutTitles = fullName.replace(/^(Mr|Mrs|Miss|Ms|Dr|Prof|Sir|Dame)\.?\s+/i, '');
  
  // Split the name by spaces
  const parts = nameWithoutTitles.split(' ');
  
  // If there are at least 3 parts, the middle parts are middle names
  if (parts.length >= 3) {
    return parts.slice(1, parts.length - 1).join(' ');
  }
  
  return null;
}

// Extract last name from a full name
function extractLastName(fullName) {
  if (!fullName) return null;
  
  // Remove titles if present
  const nameWithoutTitles = fullName.replace(/^(Mr|Mrs|Miss|Ms|Dr|Prof|Sir|Dame)\.?\s+/i, '');
  
  // Split the name by spaces
  const parts = nameWithoutTitles.split(' ');
  
  // The last part is usually the last name
  return parts[parts.length - 1] || null;
}

// Function to validate CRN against Companies House
async function validateCRNWithCompaniesHouse(crn, companyName) {
    const notes = [];
    notes.push(`Validating CRN ${crn} with Companies House...`);
    
    try {
        // Companies House API endpoint
        const endpoint = `https://api.company-information.service.gov.uk/company/${crn}`;
        
        // Get API key from environment or config
        const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
        
        if (!apiKey) {
            notes.push('No Companies House API key found. Skipping API validation.');
            
            // Fallback to public website check
            notes.push('Using Companies House website as fallback...');
            const companyUrl = `https://find-and-update.company-information.service.gov.uk/company/${crn}`;
            
            try {
                const response = await axios.get(companyUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                    },
                    timeout: 10000
                });
                
                // If we get here, the company page exists
                notes.push(`Company page found at ${companyUrl}`);
                
                // Check if company name appears on the page
                const html = response.data;
                const $ = cheerio.load(html);
                
                // Get company name from Companies House
                const chCompanyName = $('h1.heading-xlarge').text().trim();
                notes.push(`Company name found on Companies House: ${chCompanyName}`);
                
                // Compare with the provided company name
                if (companyName) {
                    const similarity = calculateNameSimilarity(companyName, chCompanyName);
                    notes.push(`Name similarity score: ${similarity}`);
                    
                    if (similarity >= 0.7) {
                        notes.push('Company name matches with high confidence.');
                        return { isValid: true, companyInfo: { name: chCompanyName }, notes, confidence: 'high' };
                    } else if (similarity >= 0.5) {
                        notes.push('Company name matches with medium confidence.');
                        return { isValid: true, companyInfo: { name: chCompanyName }, notes, confidence: 'medium' };
                    } else {
                        notes.push('Warning: Company name does not match closely.');
                        return { isValid: true, companyInfo: { name: chCompanyName }, notes, confidence: 'low' };
                    }
                }
                
                return { isValid: true, companyInfo: { name: chCompanyName }, notes, confidence: 'medium' };
                
            } catch (error) {
                notes.push(`Error checking Companies House website: ${error.message}`);
                return { isValid: false, notes, confidence: 'low' };
            }
        } else {
            // Make API request
            notes.push('Making API request to Companies House...');
            const auth = Buffer.from(`${apiKey}:`).toString('base64');
            
            const response = await axios.get(endpoint, {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                },
                timeout: 10000
            });
            
            if (response.status === 200) {
                const companyInfo = response.data;
                notes.push('Successfully retrieved company information from Companies House API.');
                
                // Extract relevant information
                const apiCompanyName = companyInfo.company_name;
                const companyStatus = companyInfo.company_status;
                const companyType = companyInfo.type;
                
                notes.push(`API returned company name: ${apiCompanyName}`);
                notes.push(`Company status: ${companyStatus}`);
                notes.push(`Company type: ${companyType}`);
                
                // Check if company is active
                if (companyStatus !== 'active') {
                    notes.push(`Warning: Company is not active. Status: ${companyStatus}`);
                }
                
                // Compare company name if provided
                if (companyName) {
                    const similarity = calculateNameSimilarity(companyName, apiCompanyName);
                    notes.push(`Name similarity score: ${similarity}`);
                    
                    if (similarity >= 0.7) {
                        notes.push('Company name matches with high confidence.');
                        return { 
                            isValid: true, 
                            companyInfo: { 
                                name: apiCompanyName, 
                                status: companyStatus, 
                                type: companyType 
                            }, 
                            notes, 
                            confidence: 'high' 
                        };
                    } else if (similarity >= 0.5) {
                        notes.push('Company name matches with medium confidence.');
                        return { 
                            isValid: true, 
                            companyInfo: { 
                                name: apiCompanyName, 
                                status: companyStatus, 
                                type: companyType 
                            }, 
                            notes, 
                            confidence: 'medium' 
                        };
                    } else {
                        notes.push('Warning: Company name does not match closely.');
                        return { 
                            isValid: true, 
                            companyInfo: { 
                                name: apiCompanyName, 
                                status: companyStatus, 
                                type: companyType 
                            }, 
                            notes, 
                            confidence: 'low' 
                        };
                    }
                }
                
                return { 
                    isValid: true, 
                    companyInfo: { 
                        name: apiCompanyName, 
                        status: companyStatus, 
                        type: companyType 
                    }, 
                    notes, 
                    confidence: 'high' 
                };
            } else {
                notes.push(`API returned non-200 status: ${response.status}`);
                return { isValid: false, notes, confidence: 'low' };
            }
        }
    } catch (error) {
        notes.push(`Error validating with Companies House: ${error.message}`);
        
        // Check if it's a 404 error, which means the company was not found
        if (error.response && error.response.status === 404) {
            notes.push('Company not found in Companies House records.');
        }
        
        return { isValid: false, notes, confidence: 'low' };
    }
}

// Helper function to calculate name similarity
function calculateNameSimilarity(name1, name2) {
    // Normalize names
    const normalizedName1 = normalizeCompanyName(name1);
    const normalizedName2 = normalizeCompanyName(name2);
    
    // Calculate Levenshtein distance
    const distance = levenshteinDistance(normalizedName1, normalizedName2);
    
    // Calculate similarity score (0 to 1, where 1 is exact match)
    const maxLength = Math.max(normalizedName1.length, normalizedName2.length);
    if (maxLength === 0) return 1.0; // Both strings are empty
    
    return 1.0 - (distance / maxLength);
}

// Normalize company name for better comparison
function normalizeCompanyName(name) {
    if (!name) return '';
    
    return name.toLowerCase()
        // Remove legal entity identifiers
        .replace(/limited|ltd\.?|llc|llp|inc\.?|incorporated|plc|corporation|corp\.?|company/gi, '')
        // Remove punctuation
        .replace(/[^\w\s]/g, '')
        // Remove extra spaces
        .replace(/\s+/g, ' ')
        .trim();
}

// Levenshtein distance calculation for string similarity
function levenshteinDistance(s1, s2) {
    if (s1.length === 0) return s2.length;
    if (s2.length === 0) return s1.length;
    
    const matrix = Array(s1.length + 1).fill().map(() => Array(s2.length + 1).fill(0));
    
    for (let i = 0; i <= s1.length; i++) {
        matrix[i][0] = i;
    }
    
    for (let j = 0; j <= s2.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= s1.length; i++) {
        for (let j = 1; j <= s2.length; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }
    
    return matrix[s1.length][s2.length];
}

async function getCompanyDetails(companyName, companyUrl) {
  try {
    console.log(`Starting KYB process for ${companyName}`);
    
    // Create result object to track all validation steps
    const result = {
      companyName,
      website: companyUrl,
      crn: null,
      crnValidations: [],
      crnConfidence: 'unknown',
      websiteValidations: [],
      notes: [],
      validationSteps: []
    };
    
    result.notes.push(`Processing company: ${companyName}`);
    result.notes.push(`Initial website: ${companyUrl || 'Not provided'}`);
    
    // Step 1: Ask OpenAI for the CRN and website
    result.validationSteps.push({ step: 'Asking OpenAI for CRN and website', status: 'in_progress' });
    const openAIResponse = await askOpenAIForCRN(companyName, companyUrl);
    
    // Handle CRN from OpenAI
    if (openAIResponse.crn) {
      result.crn = openAIResponse.crn;
      result.crnSource = 'openai';
      result.notes.push(`CRN from OpenAI: ${openAIResponse.crn}`);
      result.notes.push(...openAIResponse.notes);
      result.validationSteps[result.validationSteps.length - 1].status = 'complete';
      result.validationSteps[result.validationSteps.length - 1].result = `Found CRN: ${openAIResponse.crn}`;
      
      // Validate CRN format
      if (validateCRNFormat(openAIResponse.crn)) {
        result.notes.push('CRN format is valid');
        result.crnValidations.push({ source: 'format_check', isValid: true });
      } else {
        result.notes.push('Warning: CRN format appears invalid');
        result.crnValidations.push({ source: 'format_check', isValid: false });
      }
    } else {
      result.notes.push('No CRN found from OpenAI');
      result.validationSteps[result.validationSteps.length - 1].status = 'complete';
      result.validationSteps[result.validationSteps.length - 1].result = 'No CRN found';
    }
    
    // Handle website from OpenAI
    if (openAIResponse.website) {
      // If OpenAI found a different website than provided, note it
      if (companyUrl && openAIResponse.website !== companyUrl) {
        result.notes.push(`OpenAI found different website: ${openAIResponse.website} (originally: ${companyUrl})`);
        result.websiteValidations.push({
          source: 'openai',
          originalUrl: companyUrl,
          foundUrl: openAIResponse.website,
          status: 'different_website_found'
        });
      }
      
      // Update website if OpenAI found one and we didn't have one
      if (!result.website) {
        result.website = openAIResponse.website;
        result.websiteSource = 'openai';
        result.notes.push(`Website found by OpenAI: ${openAIResponse.website}`);
      }
    }
    
    // Step 2: Scrape website for CRN
    if (result.website) {
      result.validationSteps.push({ step: 'Scraping website for CRN', status: 'in_progress' });
      const scrapedCRNResult = await scrapeWebsiteForCRN(result.website, companyName);
      
      result.notes.push(...scrapedCRNResult.notes);
      result.validationSteps[result.validationSteps.length - 1].status = 'complete';
      
      if (scrapedCRNResult.crn) {
        result.notes.push(`CRN found on website: ${scrapedCRNResult.crn}`);
        result.validationSteps[result.validationSteps.length - 1].result = `Found CRN: ${scrapedCRNResult.crn}`;
        result.crnValidations.push({ source: 'website_scrape', isValid: true, crn: scrapedCRNResult.crn });
        
        // If we didn't have a CRN before, use this one
        if (!result.crn) {
          result.crn = scrapedCRNResult.crn;
          result.crnSource = 'website';
        } 
        // If we already had a CRN from OpenAI, check if they match
        else if (result.crn !== scrapedCRNResult.crn) {
          result.notes.push(`Warning: CRN mismatch between OpenAI (${result.crn}) and website (${scrapedCRNResult.crn})`);
          
          // Validate both CRNs with Companies House and use the one that validates
          const openAIValidation = await validateCRNWithCompaniesHouse(result.crn, companyName);
          const websiteValidation = await validateCRNWithCompaniesHouse(scrapedCRNResult.crn, companyName);
          
          result.notes.push(...openAIValidation.notes);
          result.notes.push(...websiteValidation.notes);
          
          // Choose the CRN with higher confidence
          if (websiteValidation.isValid && (websiteValidation.confidence === 'high' || !openAIValidation.isValid)) {
            result.notes.push('Using website CRN as it has higher validation confidence');
            result.crn = scrapedCRNResult.crn;
            result.crnSource = 'website';
            result.crnConfidence = websiteValidation.confidence;
          } else if (openAIValidation.isValid) {
            result.notes.push('Keeping OpenAI CRN as it has higher validation confidence');
            result.crnConfidence = openAIValidation.confidence;
          }
        } else {
          result.notes.push('CRN from OpenAI and website match. This increases confidence.');
          result.crnValidations.push({ source: 'cross_validation', isValid: true });
        }
      } else {
        result.notes.push('No CRN found on website');
        result.validationSteps[result.validationSteps.length - 1].result = 'No CRN found';
      }
    }
    
    // Step 3: Validate with Companies House
    if (result.crn) {
      result.validationSteps.push({ step: 'Validating CRN with Companies House', status: 'in_progress' });
      const validationResult = await validateCRNWithCompaniesHouse(result.crn, companyName);
      
      result.notes.push(...validationResult.notes);
      result.validationSteps[result.validationSteps.length - 1].status = 'complete';
      
      if (validationResult.isValid) {
        result.crnValidations.push({ 
          source: 'companies_house', 
          isValid: true,
          companyInfo: validationResult.companyInfo
        });
        result.crnConfidence = validationResult.confidence;
        result.registeredCompanyName = validationResult.companyInfo.name;
        result.companyStatus = validationResult.companyInfo.status;
        result.companyType = validationResult.companyInfo.type;
        
        result.validationSteps[result.validationSteps.length - 1].result = 'CRN validated';
      } else {
        result.crnValidations.push({ source: 'companies_house', isValid: false });
        result.crnConfidence = 'low';
        
        result.validationSteps[result.validationSteps.length - 1].result = 'CRN validation failed';
      }
    }
    
    // Determine overall validation status
    const hasValidCRN = result.crnValidations.some(v => v.isValid);
    const hasCompaniesHouseValidation = result.crnValidations.some(v => v.source === 'companies_house' && v.isValid);
    const hasWebsite = !!result.website;
    
    if (hasCompaniesHouseValidation && hasWebsite) {
      result.status = 'validated';
    } else if (hasCompaniesHouseValidation || (hasValidCRN && hasWebsite)) {
      result.status = 'partially_validated';
    } else if (result.crn || hasWebsite) {
      result.status = 'unvalidated';
    } else {
      result.status = 'no_information_found';
    }
    
    return result;
  } catch (error) {
    console.error('Error in getCompanyDetails:', error);
    return {
      status: 'error',
      error: error.message,
      notes: [`Error occurred: ${error.message}`]
    };
  }
}

async function askOpenAIForCRN(companyName, companyUrl) {
  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return { 
        crn: null, 
        website: null,
        notes: ['OpenAI API key not found in environment variables'] 
      };
    }

    // Construct a more precise prompt for finding the CRN and website
    const prompt = `You are a UK companies financial compliance expert specializing in company registration verification.

I need you to find the Company Registration Number (CRN) for "${companyName}".
${companyUrl ? `Their reported website is: ${companyUrl}` : ''}

CRITICAL INSTRUCTIONS - Follow these rules EXACTLY:
1. Search for a company whose registered name closely matches (at least 90% similarity) the requested business name
2. Do not confuse similar company names or subsidiaries with less than 90% name similarity
3. Verify the company is actively registered with Companies House
4. Be extremely precise about CRN format:
   - Standard CRNs are 8 digits (e.g., 12345678)
   - Scotland: SC + 6 digits (e.g., SC123456)
   - Northern Ireland: NI + 6 digits (e.g., NI123456)
   - Limited Liability Partnerships: OC + 6 digits (e.g., OC123456)

5. CHECK FOR COMMON ERRORS:
   - Do not confuse subsidiaries with parent companies
   - Do not provide CRNs for dissolved or inactive companies
   - Do not provide CRNs for similarly named but different companies (less than 90% similarity)
   - Verify all digits carefully - a single wrong digit causes compliance issues
   - Ensure you're looking at UK companies registered with Companies House

6. VERIFICATION METHODS:
   - Search official Companies House records first
   - Cross-reference with company website (typically in footer or About Us)
   - Check company documents filed with Companies House 
   - Verify through multiple sources when possible

ONLY return your findings in this JSON format:
{
  "crn": "XXXXXXXX or null if uncertain",
  "website": "https://company-site.com or null if uncertain",
  "confidence": "high|medium|low|none",
  "reasoning": "Detailed explanation of how you determined the CRN, including all verification steps and sources",
  "potential_issues": ["List any concerns or uncertainties about your determination"]
}`;

    // Call the OpenAI API
    const response = await openai.chat.completions.create({
      model: 'chatgpt-4o-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1, // Lower temperature for more deterministic answers
      max_tokens: 600
    });

    const content = response.choices[0].message.content.trim();
    let parsedResponse;
    
    try {
      // Find JSON in the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      // If JSON parsing fails, try to extract CRN and website using regex
      console.error('Error parsing OpenAI response:', parseError);
      
      // Try to find an 8-digit number or a prefixed CRN format
      const crnRegex = /\b([A-Z]{2}\d{6}|\d{8})\b/;
      const crnMatch = content.match(crnRegex);
      
      // Try to find a website URL
      const websiteRegex = /https?:\/\/[^\s,)}"']+/;
      const websiteMatch = content.match(websiteRegex);
      
      return {
        crn: crnMatch ? crnMatch[0] : null,
        website: websiteMatch ? websiteMatch[0] : null,
        confidence: 'low',
        notes: [
          'Failed to parse OpenAI JSON response',
          `Raw content: ${content.substring(0, 100)}...`,
          crnMatch ? `Extracted CRN using regex: ${crnMatch[0]}` : 'Could not extract CRN with regex',
          websiteMatch ? `Extracted website using regex: ${websiteMatch[0]}` : 'Could not extract website with regex'
        ]
      };
    }

    // If a website was provided in the input but not found by OpenAI, use the input website
    const website = parsedResponse.website || companyUrl || null;

    // Build detailed notes about the verification
    const notes = [];
    notes.push(`OpenAI confidence: ${parsedResponse.confidence || 'unknown'}`);
    notes.push(`Reasoning: ${parsedResponse.reasoning || 'No reasoning provided'}`);
    
    if (parsedResponse.potential_issues && parsedResponse.potential_issues.length > 0) {
      notes.push(`Potential issues: ${parsedResponse.potential_issues.join('; ')}`);
    }
    
    if (website) {
      notes.push(`Website identified: ${website}`);
    } else {
      notes.push('No website identified');
    }

    return {
      crn: parsedResponse.crn,
      website: website,
      confidence: parsedResponse.confidence || 'unknown',
      notes: notes,
      reasoning: parsedResponse.reasoning,
      potential_issues: parsedResponse.potential_issues
    };
  } catch (error) {
    console.error('Error in askOpenAIForCRN:', error);
    return {
      crn: null,
      website: companyUrl || null, // Return the input website if available
      confidence: 'none',
      notes: [`Error getting information from OpenAI: ${error.message}`]
    };
  }
}

// Function to scrape a website for CRNs and company name
async function scrapeWebsiteForCRN(url, companyName) {
    const notes = [];
    notes.push(`Starting website scrape for: ${url}`);

    // Initialize website data object
    const websiteData = {
        url: url,
        title: null,
        meta_description: null,
        meta_keywords: null,
        company_name: null, // Will store company name found on website
        footer_text: null, // Will store the footer text
        email_contacts: [],
        email: null, // Primary email
        phone_numbers: [],
        phone: null, // Primary phone
        social_media: [],
        crn_found: null,
        crn_location: null,
        vat_number: null, // Added VAT number
        company_description: null, // Added company description
        address: null, // Added address extraction
        last_updated: new Date().toISOString()
    };

    // Make sure the URL has the correct protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
        notes.push(`Added https:// protocol to URL: ${url}`);
        websiteData.url = url;
    }

    try {
        notes.push('Fetching website content...');
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0'
            },
            timeout: 10000
        });
        
        const html = response.data;
        notes.push('Website content fetched successfully.');

        // Clean up HTML content
        const cleanHtml = html.replace(/(\r\n|\n|\r|\t)/gm, ' ').replace(/\s+/g, ' ');
        
        // Load content into Cheerio
        const $ = cheerio.load(cleanHtml);
        
        // Extract metadata
        websiteData.title = $('title').text().trim() || null;
        websiteData.meta_description = $('meta[name="description"]').attr('content') || null;
        websiteData.meta_keywords = $('meta[name="keywords"]').attr('content') || null;
        
        // Extract company description from common selectors
        const descriptionSelectors = [
            '[itemprop="description"]',
            '.company-description',
            '#company-description',
            '.about-text',
            '#about-text',
            '.about-us-text',
            '#about-us-text',
            '.mission-statement',
            '#mission-statement',
            '.intro-text',
            '#intro-text',
            '.business-description',
            '#business-description'
        ];
        
        for (const selector of descriptionSelectors) {
            if ($(selector).length) {
                websiteData.company_description = $(selector).text().trim().substring(0, 500);
                notes.push(`Extracted company description from ${selector}`);
                break;
            }
        }
        
        // If no description found from specific selectors, try the about page
        if (!websiteData.company_description) {
            // Look for About Us link
            let aboutLink = null;
            $('a').each(function() {
                const text = $(this).text().toLowerCase();
                const href = $(this).attr('href');
                if (href && (text.includes('about') || text === 'about us' || text === 'about' || text === 'who we are')) {
                    aboutLink = href;
                    return false; // Break the loop
                }
            });
            
            // If found, try to fetch the about page
            if (aboutLink) {
                notes.push(`Found About Us link: ${aboutLink}`);
                try {
                    const aboutUrl = aboutLink.startsWith('http') ? aboutLink : 
                                    (aboutLink.startsWith('/') ? url.replace(/\/$/, '') + aboutLink : url.replace(/\/$/, '') + '/' + aboutLink);
                    
                    const aboutResponse = await axios.get(aboutUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                        },
                        timeout: 10000
                    });
                    
                    const aboutHtml = aboutResponse.data;
                    const about$ = cheerio.load(aboutHtml);
                    
                    // Extract main content from the About page
                    const aboutContent = about$('main, .main, #main, .content, #content, article, .article, #article').text().trim();
                    if (aboutContent) {
                        websiteData.company_description = aboutContent.substring(0, 500);
                        notes.push('Extracted company description from About page');
                    }
                } catch (aboutError) {
                    notes.push(`Error fetching About page: ${aboutError.message}`);
                }
            }
        }
        
        // Extract footer text
        const footerSelectors = [
            'footer',
            '.footer',
            '#footer',
            '.site-footer',
            '#site-footer',
            '.copyright',
            '#copyright',
            '.legal',
            '#legal',
            '.company-info',
            '#company-info',
            '.contact',
            '#contact',
            '[class*="footer"]',
            '[id*="footer"]',
            '[class*="copyright"]',
            '[id*="copyright"]'
        ];
        
        let footerText = '';
        for (const selector of footerSelectors) {
            const element = $(selector);
            if (element.length) {
                footerText += ' ' + element.text().trim();
            }
        }
        websiteData.footer_text = footerText.trim() || null;
        notes.push(`Footer text extracted: ${footerText.length > 0 ? 'Yes' : 'No'}`);
        
        // Company name patterns to look for in the footer
        const companyNamePatterns = [
            /©\s*(?:\d{4})?\s*([A-Za-z0-9\s&.,'()-]+?)(?:Ltd\.?|Limited|LLC|LLP|Inc\.?|PLC|Corporation|Corp\.?|Company)/i,
            /(?:©|Copyright)\s*(?:\d{4})?\s*(?:by)?\s*([A-Za-z0-9\s&.,'()-]+?)(?:\.|$|,|\s-)/i,
            /([A-Za-z0-9\s&.,'()-]+?)\s*(?:is registered in England|is a registered company)/i,
            /([A-Za-z0-9\s&.,'()-]+?)\s*(?:Ltd\.?|Limited|LLC|LLP|Inc\.?|PLC|Corporation|Corp\.?|Company)(?:\s*registered|$|\s*\d{4})/i,
            /([A-Za-z0-9\s&.,'()-]+?)\s*(?:All Rights Reserved)/i
        ];
        
        // Try to extract company name from footer text
        let extractedCompanyName = null;
        for (const pattern of companyNamePatterns) {
            const match = footerText.match(pattern);
            if (match && match[1]) {
                extractedCompanyName = match[1].trim();
                notes.push(`Extracted company name from footer: ${extractedCompanyName}`);
                break;
            }
        }
        
        // If no company name found in footer, try other parts of the page
        if (!extractedCompanyName) {
            // Look for common elements that might contain company name
            const nameSelectors = [
                '.company-name',
                '#company-name',
                '.brand',
                '.brand-name',
                '.logo-text',
                'header .logo',
                'a.navbar-brand',
                '[itemprop="name"]',
                '[itemtype="http://schema.org/Organization"] [itemprop="name"]'
            ];
            
            for (const selector of nameSelectors) {
                const element = $(selector);
                if (element.length) {
                    extractedCompanyName = element.text().trim();
                    notes.push(`Extracted company name from ${selector}: ${extractedCompanyName}`);
                    break;
                }
            }
        }
        
        // Store the extracted company name
        websiteData.company_name = extractedCompanyName;
        
        // Extract email addresses
        const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g;
        const bodyText = $('body').text();
        const emails = bodyText.match(emailRegex) || [];
        websiteData.email_contacts = [...new Set(emails)]; // Remove duplicates
        
        // Set primary email (prefer info@, contact@, or enquiries@ if available)
        if (websiteData.email_contacts.length > 0) {
            const priorityEmails = websiteData.email_contacts.filter(email => 
                email.startsWith('info@') || 
                email.startsWith('contact@') || 
                email.startsWith('enquiries@') ||
                email.startsWith('hello@')
            );
            
            websiteData.email = priorityEmails.length > 0 ? priorityEmails[0] : websiteData.email_contacts[0];
        }
        
        // Extract UK phone numbers
        const phoneRegex = /(?:\+44|0)(?:\s?\d){9,11}/g;
        const phones = bodyText.match(phoneRegex) || [];
        websiteData.phone_numbers = [...new Set(phones)]; // Remove duplicates
        
        // Set primary phone number
        if (websiteData.phone_numbers.length > 0) {
            websiteData.phone = websiteData.phone_numbers[0];
        }
        
        // Extract address from contact page or footer
        const addressSelectors = [
            '[itemprop="address"]',
            '.address',
            '#address',
            '.contact-address',
            '#contact-address',
            '.company-address',
            '#company-address',
            '.footer-address',
            '#footer-address'
        ];
        
        for (const selector of addressSelectors) {
            if ($(selector).length) {
                websiteData.address = $(selector).text().trim().replace(/\s+/g, ' ');
                break;
            }
        }
        
        // If no address found from selectors, try to find it in the footer
        if (!websiteData.address && footerText) {
            // Look for UK postcodes in the footer
            const postcodeRegex = /[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}/g;
            const postcodeMatches = footerText.match(postcodeRegex);
            
            if (postcodeMatches && postcodeMatches.length > 0) {
                // Try to extract address around the postcode
                const postcode = postcodeMatches[0];
                const postcodeIndex = footerText.indexOf(postcode);
                
                // Look for 100 characters before the postcode
                if (postcodeIndex > 0) {
                    const addressStart = Math.max(0, postcodeIndex - 100);
                    const addressEnd = postcodeIndex + postcode.length;
                    let potentialAddress = footerText.substring(addressStart, addressEnd);
                    
                    // Clean up the address
                    potentialAddress = potentialAddress.replace(/\s+/g, ' ').trim();
                    websiteData.address = potentialAddress;
                }
            }
        }
        
        // Extract VAT Number
        const vatPatterns = [
            /VAT\s+(?:Number|No|Registration)[\s:]*([A-Za-z0-9\s]{7,12})/i,
            /VAT\s+(?:Registration|Reg\.?)[\s:]*([A-Za-z0-9\s]{7,12})/i,
            /Value\s+Added\s+Tax\s+(?:Number|No)[\s:]*([A-Za-z0-9\s]{7,12})/i,
            /GB\s*VAT\s+(?:Number|No)[\s:]*([A-Za-z0-9\s]{7,12})/i,
            /VAT\s+ID[\s:]*([A-Za-z0-9\s]{7,12})/i,
            /VAT[\s:]*\s*(GB\d{9})/i,
            /Tax\s+ID[\s:]*\s*([A-Za-z0-9\s]{7,12})/i
        ];
        
        // Look for VAT number in the HTML
        for (const pattern of vatPatterns) {
            const match = cleanHtml.match(pattern);
            if (match && match[1]) {
                websiteData.vat_number = match[1].trim().replace(/\s+/g, '');
                notes.push(`Found VAT Number: ${websiteData.vat_number}`);
                break;
            }
        }
        
        // Extract social media links
        const socialPlatforms = ['facebook', 'twitter', 'linkedin', 'instagram', 'youtube'];
        $('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="linkedin.com"], a[href*="instagram.com"], a[href*="youtube.com"]').each(function() {
            const href = $(this).attr('href');
            if (href) {
                for (const platform of socialPlatforms) {
                    if (href.includes(platform)) {
                        websiteData.social_media.push({
                            platform: platform,
                            url: href.startsWith('http') ? href : (href.startsWith('/') ? url + href : url + '/' + href)
                        });
                        break;
                    }
                }
            }
        });
        
        // Remove scripts and styles to improve text extraction
        $('script, style').remove();
        
        // Define regex patterns for CRN extraction
        const crnPatterns = [
            // Standard CRN formats
            /\bCompany\s+(?:Registration\s+)?(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            /\bCRN\s*:?\s*(\d{8})\b/i,
            /\bRegistered\s+(?:Company\s+)?(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            /\bCompany\s+(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            
            // Registered in UK patterns
            /\bRegistered\s+in\s+(?:England|Scotland|Wales|UK)(?:[^.]*?)\s+(?:No|Number)\.?\s*:?\s*(\d{8})\b/i,
            /\bRegistered\s+in\s+(?:England|Scotland|Wales|UK)(?:[^.]*?)\s+(?:with\s+)?(?:Company\s+)?(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            
            // More precise matching
            /\bCompany\s+Registration\s+Number\s*:?\s*(\d{8})\b/i,
            /\bCompany\s+Number\s*:?\s*(\d{8})\b/i,
            /\bRegistration\s+Number\s*:?\s*(\d{8})\b/i,
            
            // Simple numeric patterns (should be used with caution)
            /\b((?:\d{8})|(?:[A-Z]{2}\d{6}))\b/i,
            
            // UK specific prefixed CRNs
            /\b((?:SC|NI|OC)\d{6,8})\b/i,
            
            // With context
            /\bregistered\s+(?:company|business)(?:[^.]*?)\s+(?:number|no)\.?\s*:?\s*(\d{8})\b/i,
            /\b(?:incorporated|trading)(?:[^.]*?)\s+(?:number|no)\.?\s*:?\s*(\d{8})\b/i,
            
            // With Companies House reference
            /\bCompanies\s+House\s+(?:Number|No|Registration)\.?\s*:?\s*(\d{8})\b/i,
            /\bregistered\s+with\s+Companies\s+House(?:[^.]*?)\s+(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            
            // Special format with prefixes
            /\bCompany\s+(?:Registration\s+)?(?:Number|No)\.?\s*:?\s*((?:SC|NI|OC)\d{6,8})\b/i,
            /\bCRN\s*:?\s*((?:SC|NI|OC)\d{6,8})\b/i,
            
            // VAT and CRN combined patterns (extract only CRN)
            /\bVAT(?:[^.]*?)(?:Company|Registration)\s+(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            
            // Specific footer patterns 
            /\b(?:©|Copyright)(?:[^.]*?)(?:Company|Registration)\s+(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            /\b(?:©|Copyright)(?:[^.]*?)(?:registered\s+(?:in|with))(?:[^.]*?)(\d{8})\b/i,
            
            // Common footer format with year
            /\b(?:\d{4})(?:[^.]*?)(?:Company|Registration)\s+(?:Number|No)\.?\s*:?\s*(\d{8})\b/i,
            
            // Pattern with limited by guarantee wording
            /\blimited\s+by\s+guarantee(?:[^.]*?)(?:registration|company)\s+(?:number|no)\.?\s*:?\s*(\d{8})\b/i,
            
            // UK business patterns
            /\bUK\s+registered\s+company(?:[^.]*?)(?:number|no)\.?\s*:?\s*(\d{8})\b/i,
            /\bUK\s+company\s+(?:number|no)\.?\s*:?\s*(\d{8})\b/i
        ];
        
        // Check for CRNs in HTML content using regex patterns
        for (const pattern of crnPatterns) {
            const match = cleanHtml.match(pattern);
            if (match && match[1]) {
                const potentialCRN = match[1].trim();
                notes.push(`Found potential CRN using pattern ${pattern}: ${potentialCRN}`);
                
                // Validate CRN format
                if (validateCRNFormat(potentialCRN)) {
                    notes.push(`Valid CRN format found: ${potentialCRN}`);
                    websiteData.crn_found = potentialCRN;
                    websiteData.crn_location = "main_page";
                    
                    // Extract some context around the CRN
                    const contextMatch = cleanHtml.match(new RegExp(`.{0,50}${potentialCRN}.{0,50}`, 'i'));
                    if (contextMatch) {
                        websiteData.crn_context = contextMatch[0].trim();
                    }
                    
                    return { crn: potentialCRN, notes, scrapeData: websiteData };
                } else {
                    notes.push(`Invalid CRN format: ${potentialCRN}`);
                }
            }
        }
        
        // Continue with the rest of the function to check common elements and pages for CRNs
        // (Keeping the existing code from here on)
        
        // Check common elements that might contain CRNs
        const elementSelectors = [
            'footer',
            '.footer',
            '#footer',
            '.site-footer',
            '#site-footer',
            '.copyright',
            '#copyright',
            '.legal',
            '#legal',
            '.terms',
            '#terms',
            '.company-info',
            '#company-info',
            '.about-us',
            '#about-us',
            '.contact',
            '#contact',
            '[class*="footer"]',
            '[id*="footer"]',
            '[class*="copyright"]',
            '[id*="copyright"]',
            '.small-print',
            '#small-print',
            '.bottom',
            '#bottom',
            '.site-info',
            '#site-info',
            '.legal-info',
            '#legal-info',
            '[class*="legal"]',
            '[id*="legal"]'
        ];
        
        // Continue with the existing code checking for CRNs in common elements
        // ...
        
        // If we got here, we didn't find a valid CRN but we might have found a company name and other data
        notes.push('No valid CRN found on website after checking main page and common pages.');
        return { crn: null, notes, scrapeData: websiteData };
        
    } catch (error) {
        notes.push(`Error scraping website: ${error.message}`);
        return { crn: null, notes, scrapeData: websiteData };
    }
}

// Function to estimate job progress percentage
function calculateJobProgress(status, logSteps) {
  switch (status) {
    case 'pending':
      return 0;
    case 'processing':
      // Calculate based on typical workflow steps (roughly 10 steps in a complete process)
      return Math.min(Math.round((logSteps / 10) * 100), 90); // Cap at 90% until completed
    case 'action_required':
      return 50; // Usually around halfway when user input is needed
    case 'completed':
      return 100;
    case 'failed':
      // Failed jobs show progress based on how far they got
      return Math.min(Math.round((logSteps / 10) * 100), 100);
    default:
      return 0;
  }
}

// Start API server with better error handling
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`KYB API service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Visit http://localhost:${PORT} to access the verification UI`);
})
.on('error', (err) => {
  console.error('ERROR STARTING SERVER:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Make sure no other instance is running or use a different port.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Add a utility function for string similarity near the top of the file
function calculateStringSimilarity(str1, str2) {
  // Convert both strings to lowercase and remove common business terms and punctuation
  const normalize = (s) => {
    return s.toLowerCase()
      .replace(/(ltd|limited|plc|llp|inc|gmbh|llc|corporation|corp|group|holdings|uk)(\s|$)/g, ' ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };
  
  const a = normalize(str1);
  const b = normalize(str2);
  
  // If either string is empty after normalization, return 0
  if (!a.length || !b.length) return 0;
  
  // Calculate Levenshtein distance
  const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));
  
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + substitutionCost // substitution
      );
    }
  }
  
  // Convert to similarity score between 0 and 1
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1; // Edge case: both strings are empty after normalization
  
  return 1 - (matrix[b.length][a.length] / maxLength);
}

// Add a function to search Companies House for a company name
async function searchCompaniesHouseByName(companyName) {
  try {
    // Get API key from environment variables
    const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
    if (!apiKey) {
      console.error('Companies House API key not found in environment variables');
      return { success: false, error: 'API key missing', results: [] };
    }
    
    // URL encode the company name
    const encodedName = encodeURIComponent(companyName);
    
    // Create the API URL for company search
    const url = `https://api.company-information.service.gov.uk/search/companies?q=${encodedName}`;
    
    // Set up authentication for Companies House API (Basic Auth with API key as username and empty password)
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    
    // Make the request to Companies House API
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      return { 
        success: false, 
        error: `Companies House API error: ${response.status} ${response.statusText}`,
        details: errorData,
        results: []
      };
    }
    
    const data = await response.json();
    
    // Return the search results
    return { 
      success: true, 
      results: data.items || [],
      total_results: data.total_results || 0
    };
  } catch (error) {
    console.error('Error searching Companies House by name:', error);
    return { 
      success: false, 
      error: `Error searching Companies House: ${error.message}`,
      results: []
    };
  }
}

// Then update the processCompanyDetails function to handle name mismatches
async function processCompanyDetails(companyData) {
  const companyDetails = { ...companyData };
  const logs = [];
  
  logs.push(`Processing company: ${companyDetails.company_name}`);
  
  // Validate the company name
  if (!companyDetails.company_name) {
    logs.push('ERROR: Company name is missing');
    companyDetails.validation_issues = [
      ...(companyDetails.validation_issues || []),
      'Company name is missing'
    ];
  }
  
  // If there's no CRN, try to get it from OpenAI
  if (!companyDetails.crn) {
    logs.push('No CRN provided, attempting to retrieve from OpenAI');
    const openAIResponse = await askOpenAIForCRN(
      companyDetails.company_name, 
      companyDetails.website
    );
    
    companyDetails.crn = openAIResponse.crn;
    companyDetails.crn_confidence = openAIResponse.confidence;
    companyDetails.ai_notes = openAIResponse.notes;
    
    if (openAIResponse.reasoning) {
      companyDetails.crn_reasoning = openAIResponse.reasoning;
    }
    
    if (openAIResponse.potential_issues) {
      companyDetails.crn_potential_issues = openAIResponse.potential_issues;
    }
    
    logs.push(`CRN from OpenAI: ${companyDetails.crn || 'Not found'} (Confidence: ${companyDetails.crn_confidence})`);
  } else {
    logs.push(`CRN provided: ${companyDetails.crn}`);
  }
  
  // If we have a CRN, validate it and get company data from Companies House
  if (companyDetails.crn) {
    // First, validate the format of the CRN
    if (!validateCRNFormat(companyDetails.crn)) {
      logs.push(`WARNING: Invalid CRN format: ${companyDetails.crn}`);
      companyDetails.validation_issues = [
        ...(companyDetails.validation_issues || []),
        `Invalid CRN format: ${companyDetails.crn}`
      ];
    }
    
    // Fetch company details from Companies House
    const chResponse = await getCompanyFromCompaniesHouse(companyDetails.crn);
    
    if (!chResponse.success) {
      logs.push(`ERROR: Companies House API error: ${chResponse.error}`);
      companyDetails.validation_issues = [
        ...(companyDetails.validation_issues || []),
        `Companies House API error: ${chResponse.error}`
      ];
    } else {
      // Add Companies House data to company details
      companyDetails.companies_house_data = chResponse.data;
      logs.push(`Companies House data retrieved for ${companyDetails.crn}`);
      
      // Check if the company is still active
      if (chResponse.data.company_status && chResponse.data.company_status !== 'active') {
        logs.push(`WARNING: Company status is not active: ${chResponse.data.company_status}`);
        companyDetails.validation_issues = [
          ...(companyDetails.validation_issues || []),
          `Company status is not active: ${chResponse.data.company_status}`
        ];
      }
      
      // Verify that the company name matches the one from Companies House
      if (companyDetails.company_name && chResponse.data.company_name) {
        // Calculate similarity between website company name and Companies House name
        const similarityScore = calculateStringSimilarity(
          companyDetails.company_name,
          chResponse.data.company_name
        );
        
        companyDetails.name_similarity_score = similarityScore;
        logs.push(`Name similarity score: ${similarityScore.toFixed(2)}`);
        
        // If similarity is below threshold, there might be a mismatch
        if (similarityScore < 0.7) {
          logs.push(`WARNING: Company name mismatch. Website: "${companyDetails.company_name}", Companies House: "${chResponse.data.company_name}"`);
          
          // Search Companies House for the website company name
          logs.push(`Searching Companies House for the website company name: "${companyDetails.company_name}"`);
          const searchResponse = await searchCompaniesHouseByName(companyDetails.company_name);
          
          if (searchResponse.success && searchResponse.results.length > 0) {
            companyDetails.alternative_companies = searchResponse.results.slice(0, 5); // Keep top 5 matches
            
            // Find the best match based on name similarity
            let bestMatch = null;
            let bestScore = 0;
            
            for (const company of searchResponse.results) {
              const score = calculateStringSimilarity(companyDetails.company_name, company.title);
              if (score > bestScore && score > 0.7) {
                bestScore = score;
                bestMatch = company;
              }
            }
            
            if (bestMatch) {
              logs.push(`Found better match: "${bestMatch.title}" (${bestMatch.company_number}) with similarity score ${bestScore.toFixed(2)}`);
              
              companyDetails.suggested_crn = bestMatch.company_number;
              companyDetails.suggested_company_name = bestMatch.title;
              companyDetails.suggested_similarity_score = bestScore;
              
              companyDetails.validation_issues = [
                ...(companyDetails.validation_issues || []),
                `Possible CRN mismatch. Current CRN (${companyDetails.crn}) may be incorrect. Suggested CRN: ${bestMatch.company_number}`
              ];
              
              // Optionally, get detailed data for the suggested company
              const suggestedCompanyResponse = await getCompanyFromCompaniesHouse(bestMatch.company_number);
              if (suggestedCompanyResponse.success) {
                companyDetails.suggested_company_data = suggestedCompanyResponse.data;
              }
            } else {
              logs.push(`No better match found in the ${searchResponse.results.length} search results`);
            }
          } else {
            logs.push(`No search results found for "${companyDetails.company_name}" or search failed`);
          }
          
          // Add validation issue for the name mismatch
          companyDetails.validation_issues = [
            ...(companyDetails.validation_issues || []),
            `Company name mismatch. Website: "${companyDetails.company_name}", Companies House: "${chResponse.data.company_name}"`
          ];
          
          // If AI verification is needed for the name mismatch
          // Request further verification from AI
          logs.push('Requesting further AI verification for name mismatch');
          const verificationResponse = await askOpenAIForCRNVerification(
            companyDetails.company_name,
            chResponse.data.company_name,
            companyDetails.crn,
            companyDetails.website,
            companyDetails.alternative_companies || []
          );
          
          companyDetails.ai_verification = verificationResponse;
          logs.push(`AI verification result: ${verificationResponse.conclusion}`);
          
          if (verificationResponse.recommended_crn !== companyDetails.crn) {
            logs.push(`AI recommends different CRN: ${verificationResponse.recommended_crn}`);
            companyDetails.ai_recommended_crn = verificationResponse.recommended_crn;
            
            // Get data for the AI-recommended CRN if it's different
            if (verificationResponse.recommended_crn) {
              const recommendedCompanyResponse = await getCompanyFromCompaniesHouse(verificationResponse.recommended_crn);
              if (recommendedCompanyResponse.success) {
                companyDetails.ai_recommended_company_data = recommendedCompanyResponse.data;
              }
            }
          }
        } else {
          logs.push(`Company name verified. Good match between "${companyDetails.company_name}" and "${chResponse.data.company_name}"`);
        }
      }
    }
  } else {
    logs.push('ERROR: No CRN available after OpenAI processing');
    companyDetails.validation_issues = [
      ...(companyDetails.validation_issues || []),
      'CRN could not be determined'
    ];
  }
  
  // Add processing logs to the company details
  companyDetails.processing_logs = logs;
  
  return companyDetails;
}

// Add a function for AI verification of mismatches
async function askOpenAIForCRNVerification(websiteCompanyName, chCompanyName, currentCRN, companyUrl, alternativeCompanies = []) {
  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return {
        conclusion: 'verification_failed',
        notes: ['OpenAI API key not found in environment variables'],
        recommended_crn: currentCRN
      };
    }

    // Format alternative companies for the prompt
    let alternativesText = '';
    if (alternativeCompanies.length > 0) {
      alternativesText = 'Alternative company matches from Companies House:\n';
      alternativeCompanies.forEach((company, index) => {
        alternativesText += `${index + 1}. "${company.title}" - CRN: ${company.company_number} - Status: ${company.company_status}\n`;
      });
    }

    // Construct the verification prompt
    const prompt = `You are a UK company verification expert specializing in resolving CRN verification issues.

I've found a potential mismatch between a company name on a website and its Companies House record:

Website company name: "${websiteCompanyName}"
Companies House name: "${chCompanyName}"
Current CRN: ${currentCRN}
${companyUrl ? `Company website: ${companyUrl}` : ''}

${alternativesText}

I need you to analyze this discrepancy and determine if:
1. This is the same company with a slight name variation (common legal variations, trading names, etc.)
2. This is a completely different company and the CRN is incorrect
3. Additional verification is needed to determine the correct match

CRITICAL INSTRUCTIONS:
- Analyze name similarities accounting for common variations (Ltd/Limited, Group, Holdings, etc.)
- Consider that websites often use trading names rather than full legal names
- If this appears to be the same company with minor name variations, confirm the CRN is correct
- If this appears to be a different company, recommend the correct CRN from the alternatives
- Consider company status, registration date, and other factors in your analysis

ONLY return your analysis in this JSON format:
{
  "conclusion": "confirmed_match|possible_match|likely_mismatch|confirmed_mismatch|verification_needed",
  "recommended_crn": "The CRN you believe is correct based on your analysis, or null if uncertain",
  "reasoning": "Detailed explanation of your analysis and conclusion",
  "confidence": "high|medium|low",
  "recommended_actions": ["List of specific steps to resolve this verification issue"]
}`;

    // Call the OpenAI API
    const response = await openai.chat.completions.create({
      model: 'chatgpt-4o-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 600
    });

    const content = response.choices[0].message.content.trim();
    let parsedResponse;
    
    try {
      // Find JSON in the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Error parsing OpenAI verification response:', parseError);
      return {
        conclusion: 'verification_failed',
        reasoning: `Failed to parse AI response: ${parseError.message}`,
        confidence: 'none',
        recommended_crn: currentCRN, // Keep the current CRN if parsing fails
        notes: [`Raw response: ${content.substring(0, 100)}...`]
      };
    }

    return {
      conclusion: parsedResponse.conclusion || 'verification_failed',
      recommended_crn: parsedResponse.recommended_crn || currentCRN,
      reasoning: parsedResponse.reasoning || 'No reasoning provided',
      confidence: parsedResponse.confidence || 'low',
      recommended_actions: parsedResponse.recommended_actions || [],
      raw_response: parsedResponse
    };
  } catch (error) {
    console.error('Error in askOpenAIForCRNVerification:', error);
    return {
      conclusion: 'verification_failed',
      reasoning: `Error during verification: ${error.message}`,
      confidence: 'none',
      recommended_crn: currentCRN, // Keep the current CRN if verification fails
      recommended_actions: ['Manual verification required due to API error']
    };
  }
}

// Function to fetch company data from Companies House by CRN
async function getCompanyFromCompaniesHouse(crn) {
  try {
    // Get API key from environment variables
    const apiKey = process.env.COMPANIES_HOUSE_API_KEY || COMPANY_HOUSE_API_KEY;
    if (!apiKey) {
      console.error('Companies House API key not found');
      return { success: false, error: 'API key missing' };
    }
    
    // Create the API URL for company profile
    const url = `https://api.company-information.service.gov.uk/company/${crn}`;
    
    try {
      // Make the request to Companies House API
      const response = await axios.get(url, {
        auth: { username: apiKey, password: '' },
        timeout: 10000,
        headers: {
          'Accept': 'application/json'
        },
        validateStatus: function (status) {
          // Only treat 2xx status codes as successful
          return status >= 200 && status < 300;
        }
      });
      
      // Return the company data
      return { 
        success: true, 
        data: response.data
      };
    } catch (apiError) {
      // Handle API errors specifically
      if (apiError.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        const status = apiError.response.status;
        
        if (status === 404) {
          return { 
            success: false, 
            error: `Company not found with CRN: ${crn}`,
            status: 404
          };
        } else {
          return { 
            success: false, 
            error: `Companies House API error: ${status}`,
            status: status,
            response_data: typeof apiError.response.data === 'object' ? 
              apiError.response.data : 
              { raw: 'Non-JSON response received' }
          };
        }
      } else if (apiError.request) {
        // The request was made but no response was received
        return { 
          success: false, 
          error: 'No response received from Companies House API',
          network_error: true
        };
      } else {
        // Something happened in setting up the request that triggered an Error
        return { 
          success: false, 
          error: `Error setting up request: ${apiError.message}`,
          request_error: true
        };
      }
    }
  } catch (error) {
    console.error(`Error in getCompanyFromCompaniesHouse for CRN ${crn}:`, error.message);
    return { 
      success: false, 
      error: `Unexpected error: ${error.message}`,
      fatal_error: true
    };
  }
}
