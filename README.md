# KYB Automation API Service

API service for Know Your Business (KYB) automation, integrating with Companies House and using AI analysis.

## Setup

1. Install dependencies:
```
npm install
```

2. Set up environment variables:
```
OPENAI_API_KEY=your_openai_api_key
COMPANY_HOUSE_API_KEY=your_companies_house_api_key
REDIS_URL=redis://127.0.0.1:6379 (default)
PORT=3010 (default)
```

3. Make sure Redis is running (required for BullMQ)

4. Start the server:
```
npm start
```

## Deployment to Render.com

This project includes configuration for simple deployment to Render.com:

1. Push this repository to GitHub or GitLab

2. In your Render.com dashboard:
   - Go to "Blueprints"
   - Click "New Blueprint Instance"
   - Connect your Git repository
   - Render will automatically detect the `render.yaml` configuration

3. During setup, you'll need to provide:
   - `OPENAI_API_KEY` - Your OpenAI API key
   - `COMPANY_HOUSE_API_KEY` - Your Companies House API key
   
4. Render will automatically:
   - Set up a web service for the API
   - Create a managed Redis instance
   - Link them together

5. Once deployed, you can access your API at the URL provided by Render

## API Endpoints

- `POST /startKYB` - Start a KYB check for a business
  - Request body: `{ "business_name": "Example Ltd" }`
  - Response: `{ "job_id": "..." }`

- `GET /jobStatus?job_id=YOUR_JOB_ID` - Check status of a KYB job
  - Response: `{ "status": "pending|processing|completed|failed|action_required" }`

- `GET /jobLog?job_id=YOUR_JOB_ID` - Get detailed results of a KYB job

- `POST /continueKYB` - Provide additional information to continue a stuck KYB process
  - Used when a job has status "action_required"
  - Request body: `{ "job_id": "YOUR_JOB_ID", ... }`
  - Three main ways to continue a job:
    1. Provide a new company name: `{ "job_id": "...", "company_name": "Correct Name Ltd" }`
       - This will restart the entire KYB process with the new name
       - The system will attempt to find the CRN and website automatically
    2. Provide a CRN directly: `{ "job_id": "...", "crn": "12345678" }`
       - This will skip the AI lookup and go directly to Companies House
    3. Provide both: `{ "job_id": "...", "company_name": "Name Ltd", "crn": "12345678" }`
       - The CRN takes precedence and will be used directly

### Search Capabilities

- `GET /searchCompany?name=COMPANY_NAME` - Search for companies by name
  - Returns top 5 matches from Companies House
  - Response: `{ "results": [{ "company_name", "company_number", "company_status", "address" }, ...] }`

- `GET /companyProfile?crn=COMPANY_NUMBER` - Get detailed profile for a specific CRN
  - Response: Full company profile from Companies House API

## Features

- **Enhanced CRN Detection**: Multiple pattern matching algorithms to find UK Company Registration Numbers
- **Fallback Methods**: Automatic fallback to Companies House direct search if OpenAI can't find the CRN
- **Multiple Validation Attempts**: Uses multiple AI prompts if necessary
- **Interactive Workflow**: Allows providing missing information for stuck processes
- **Comprehensive Logging**: Each job tracks all steps and data collected
- **Automatic Document Retrieval**: Downloads and stores incorporation documents
- **Website Scraping**: Extracts contact details and validates against official records 