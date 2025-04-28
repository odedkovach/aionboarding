// KYB Automation API Service in Node.js
// Full Implementation with Express.js and External Integrations

// Import libraries
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const OpenAI = require('openai');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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
  return res.json({ status: jobStatus[job_id] });
});

// GET /jobLog
app.get('/jobLog', (req, res) => {
  const { job_id } = req.query;
  if (!jobLogs[job_id]) return res.status(404).json({ error: 'Job not found' });
  console.log(`[${new Date().toISOString()}] Job log request for ${job_id}`);
  return res.json(jobLogs[job_id]);
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
      // Return the top 5 matches
      const topMatches = searchResponse.data.items.slice(0, 5).map(item => ({
        company_name: item.title,
        company_number: item.company_number,
        company_status: item.company_status,
        address: item.address_snippet
      }));
      
      return res.json({ results: topMatches });
    } else {
      return res.json({ results: [] });
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

    const companyData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
      auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
    });
    
    return res.json(companyData.data);
  } catch (err) {
    console.error('Error fetching company profile:', err.message);
    return res.status(500).json({ error: 'Error fetching company profile: ' + err.message });
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

      // Step 1: Get CRN and Website from OpenAI
      console.log(`[${new Date().toISOString()}] [${jobId}] Querying OpenAI for CRN and website information`);
      const openaiPrompt = `Find the UK company registration number (CRN) and website for "${business_name}".
      The CRN should be in one of these formats:
      - 8 digits (e.g., 12345678)
      - 2 uppercase letters followed by 6 digits (e.g., SC123456, NI123456)
      
      Format your response as:
      CRN: [the company registration number]
      Website: [the website URL]
      Additional information: [any other relevant details]`;
      
      console.log(`[${new Date().toISOString()}] [${jobId}] OpenAI Request:`, { 
        model: 'gpt-4.1-2025-04-14',
        prompt: openaiPrompt
      });
      
      let aiText = '';
      try {
        // Set a timeout for the OpenAI request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        try {
          const openaiPromise = openai.chat.completions.create({
            model: 'gpt-4.1-2025-04-14',
            messages: [{ 
              role: 'user', 
              content: openaiPrompt
            }],
            temperature: 0,
            max_tokens: 500 // Limit response size
          }, { signal: controller.signal });
          
          const gptResponse = await openaiPromise;
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
      
      jobLogs[jobId].push({ step: 'GPT Result', data: aiText });

      // Try to find CRN with various patterns
      let crn = null;
      let website = null;
      
      // Try explicit label first
      const crnLabelMatch = aiText.match(/CRN:\s*([A-Z]{0,2}\d{6,8})/);
      if (crnLabelMatch) {
        crn = crnLabelMatch[1];
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
            crn = match[1];
            break;
          }
        }
      }

      // Extract website with improved pattern
      const websiteLabelMatch = aiText.match(/Website:\s*(https?:\/\/[^\s,]+)/);
      if (websiteLabelMatch) {
        website = websiteLabelMatch[1];
      } else {
        // Fallback to generic URL pattern
        const websiteMatch = aiText.match(/https?:\/\/[^\s,]+/);
        website = websiteMatch ? websiteMatch[0] : null;
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
            // Take the first (best) match
            const bestMatch = searchResponse.data.items[0];
            crn = bestMatch.company_number;
            console.log(`[${new Date().toISOString()}] [${jobId}] Found company via Companies House search: ${bestMatch.title} (CRN: ${crn})`);
            jobLogs[jobId].push({ 
              step: 'Companies House Search Result', 
              data: `Found company: ${bestMatch.title} with CRN: ${crn}` 
            });
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
          
          const secondPrompt = `I need ONLY the UK company registration number for "${business_name}". 
          Just give me the 8-digit number or SC/NI followed by 6 digits. 
          Format: "CRN: 12345678" or "CRN: SC123456". Nothing else.`;
          
          console.log(`[${new Date().toISOString()}] [${jobId}] Second OpenAI Request:`, { 
            model: 'gpt-4.1-2025-04-14',
            prompt: secondPrompt
          });
          
          // Set a timeout for the OpenAI request
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          let secondAttemptText = '';
          try {
            const secondAttemptResponse = await openai.chat.completions.create({
              model: 'gpt-4.1-2025-04-14',
              messages: [{ 
                role: 'user', 
                content: secondPrompt
              }],
              temperature: 0,
              max_tokens: 200 // Limit response size
            }, { signal: controller.signal });
            
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
          
          const secondMatch = secondAttemptText.match(/CRN:\s*([A-Z]{0,2}\d{6,8})/i);
          
          if (secondMatch) {
            crn = secondMatch[1];
            jobLogs[jobId].push({ step: 'Second AI Attempt', data: secondAttemptText });
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
          message: 'Could not find CRN automatically. Please provide the Company Registration Number or additional details.',
          required_fields: {
            crn: 'Company Registration Number (8 digits or 2 letters + 6 digits)',
            website: 'Company website URL (optional)',
            company_name: 'Exact company name (optional)'
          }
        });
        return; // End processing here, waiting for user input
      }
      
      // Now we have a CRN to work with
      // Step 2: Fetch Company Details from Companies House
      return await this.processCRN(jobId, business_name, crn, website);
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
        const openaiPrompt = `Find the UK company registration number (CRN) and website for "${newBusinessName}".
        The CRN should be in one of these formats:
        - 8 digits (e.g., 12345678)
        - 2 uppercase letters followed by 6 digits (e.g., SC123456, NI123456)
        
        Format your response as:
        CRN: [the company registration number]
        Website: [the website URL]
        Additional information: [any other relevant details]`;
        
        console.log(`[${new Date().toISOString()}] [${job_id}] OpenAI Request:`, { 
          model: 'gpt-4.1-2025-04-14',
          prompt: openaiPrompt
        });
        
        let aiText = '';
        try {
          // Use the same OpenAI request pattern as the original job
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          const openaiPromise = openai.chat.completions.create({
            model: 'gpt-4.1-2025-04-14',
            messages: [{ 
              role: 'user', 
              content: openaiPrompt
            }],
            temperature: 0,
            max_tokens: 500
          }, { signal: controller.signal });
          
          try {
            const gptResponse = await openaiPromise;
            aiText = gptResponse.choices[0].message.content;
            console.log(`[${new Date().toISOString()}] [${job_id}] OpenAI Response:`, {
              content: aiText,
              finish_reason: gptResponse.choices[0].finish_reason,
              model: gptResponse.model,
              usage: gptResponse.usage
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
    console.log(`[${new Date().toISOString()}] [${jobId}] Processing CRN: ${crn}`);
    
    try {
      // Step 2: Fetch Company Details from Companies House
      console.log(`[${new Date().toISOString()}] [${jobId}] Fetching company details for CRN: ${crn}`);
      const companyData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}`, {
        auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
      });
      const companyProfile = companyData.data;
      console.log(`[${new Date().toISOString()}] [${jobId}] Retrieved company profile for ${companyProfile.company_name}`);
      jobLogs[jobId].push({ step: 'Companies House Profile', data: companyProfile });
      
      // Step 3: Fetch Officers (Directors)
      console.log(`[${new Date().toISOString()}] [${jobId}] Fetching company officers`);
      const officersData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}/officers`, {
        auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
      });
      const officers = officersData.data.items.map(o => o.name);
      console.log(`[${new Date().toISOString()}] [${jobId}] Found ${officers.length} officers`);
      
      // Step 4: Fetch PSC (Beneficial Owners)
      console.log(`[${new Date().toISOString()}] [${jobId}] Fetching persons with significant control`);
      const pscData = await axios.get(`https://api.company-information.service.gov.uk/company/${crn}/persons-with-significant-control`, {
        auth: { username: COMPANY_HOUSE_API_KEY, password: '' }
      });
      const owners = pscData.data.items.map(p => ({
        name: p.name,
        ownership_percent: p.percent_of_shares || '>25%',
        date_of_birth: p.date_of_birth ? `${p.date_of_birth.year}-${p.date_of_birth.month}` : null
      }));
      console.log(`[${new Date().toISOString()}] [${jobId}] Found ${owners.length} beneficial owners`);
      
      // Step A: Download Incorporation Document
      console.log(`[${new Date().toISOString()}] [${jobId}] Attempting to download incorporation document`);
      const incorporationDocumentUrl = await downloadIncorporationDocument(crn, jobId);
      
      // Step B: Collect website info if available
      let phone = null;
      let addressFromWebsite = null;
      
      if (website) {
        try {
          console.log(`[${new Date().toISOString()}] [${jobId}] Scraping website: ${website}`);
          const websiteResp = await axios.get(website, { timeout: 10000 });
          const $ = cheerio.load(websiteResp.data);
          const text = $('body').text();
          const phoneMatch = text.match(/\+?\d[\d\s\-]{7,}\d/);
          if (phoneMatch) phone = phoneMatch[0].trim();
          const addressCandidate = $('address').text() || '';
          if (addressCandidate.length > 10) addressFromWebsite = addressCandidate.trim();
          
          console.log(`[${new Date().toISOString()}] [${jobId}] Website scrape results: `, {
            phone: phone || 'Not found',
            address: addressFromWebsite || 'Not found'
          });
        } catch (e) {
          console.error(`[${new Date().toISOString()}] [${jobId}] Website scrape failed: ${e.message}`);
          jobLogs[jobId].push({ step: 'Website Scrape Failed', error: e.message });
        }
      }
      
      // Step C: Cross-Validate Address
      let addressMatch = false;
      if (companyProfile.registered_office_address) {
        const registeredAddress = `${companyProfile.registered_office_address.address_line_1 || ''} ${companyProfile.registered_office_address.locality || ''} ${companyProfile.registered_office_address.postal_code || ''}`;
        const normalizedRegistered = normalizeAddress(registeredAddress);
        const normalizedWebsite = addressFromWebsite ? normalizeAddress(addressFromWebsite) : null;
      
        if (normalizedWebsite && normalizedRegistered.includes(normalizedWebsite)) {
          addressMatch = true;
          console.log(`[${new Date().toISOString()}] [${jobId}] Address validated: Website address matches registered address`);
        }
      }
      
      // Final result compilation
      const result = {
        company_name: companyProfile.company_name,
        company_registration_number: crn,
        company_status: companyProfile.company_status,
        company_type: companyProfile.type,
        incorporation_date: companyProfile.date_of_creation,
        registered_address: companyProfile.registered_office_address,
        business_address: addressFromWebsite || companyProfile.registered_office_address,
        website_url: website,
        contact_phone: phone,
        nature_of_business: companyProfile.sic_codes,
        beneficial_owners: owners,
        directors: officers,
        companies_house_profile_url: `https://find-and-update.company-information.service.gov.uk/company/${crn}`,
        incorporation_document_url: incorporationDocumentUrl,
        verification_status: addressMatch ? 'verified' : 'warning: address mismatch'
      };
      
      console.log(`[${new Date().toISOString()}] [${jobId}] KYB process completed successfully`);
      jobLogs[jobId] = result;
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
};

// Root endpoint to serve UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create public directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'public'))) {
  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

// Create inc_docs directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'inc_docs'))) {
  fs.mkdirSync(path.join(__dirname, 'inc_docs'), { recursive: true });
}

// Start API server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KYB API service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Visit http://localhost:${PORT} to access the verification UI`);
})
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Make sure no other instance is running or use a different port.`);
      process.exit(1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
