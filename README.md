# AI Onboarding Platform

A modern onboarding system for business verification that leverages AI to enhance data collection and verification processes.

## Features

- Multi-step onboarding wizard with smooth transitions
- AI-powered data enhancement to fill in missing business information
- Real-time validation with interactive feedback
- Automatic business verification using Companies House and public records
- Modern, responsive UI design

## AI Data Enhancement

The platform includes a special step to identify missing business information and uses OpenAI to search for and retrieve that data:

1. The system analyzes the provided business information
2. It identifies missing fields that would improve verification success
3. With user consent, it sends a request to OpenAI to search for the missing information
4. Retrieved data is presented to the user for approval before being added to their profile

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn

### Installation

1. Clone the repository
   ```
   git clone https://github.com/yourusername/onboarding-ai.git
   cd onboarding-ai
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Configure OpenAI API Key
   - Rename `.env.example` to `.env`
   - Add your OpenAI API key to the `.env` file
   ```
   OPENAI_API_KEY=your_api_key_here
   ```

4. Start the development server
   ```
   npm run dev
   ```

5. Open your browser and navigate to `http://localhost:3000`

## System Architecture

The platform consists of:

- Front-end: HTML5, CSS3, Vanilla JavaScript with utility classes
- Back-end: Node.js with Express
- External Services: OpenAI API for business data enhancement

## Implementation Details

- The system uses a progressive enhancement approach for the onboarding flow
- Business verification uses a combination of automated checks and AI assistance
- Missing data is retrieved using carefully crafted prompts to OpenAI
- All API calls include proper error handling and timeout management

## Security Considerations

- OpenAI API requests are made server-side to protect the API key
- User consent is required before any AI data enhancement is performed
- All enhanced data is presented to the user for verification before use
- No sensitive business information is stored unless explicitly approved by the user

## License

MIT 