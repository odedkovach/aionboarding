const axios = require('axios');

async function testKYBService() {
  try {
    // Test company details
    const companyName = "Google UK Limited";
    const companyUrl = "https://www.google.co.uk";

    console.log(`Testing KYB service for company: ${companyName}`);
    console.log(`API URL: http://localhost:3011/startKYB`);
    
    // Start KYB process with website information
    const startResponse = await axios.post('http://localhost:3011/startKYB', {
      business_name: companyName,
      website: companyUrl
    });
    
    const jobId = startResponse.data.job_id;
    console.log(`Started KYB job with ID: ${jobId}`);
    
    // Poll for job status
    let status = 'pending';
    while (status === 'pending' || status === 'processing') {
      const statusResponse = await axios.get(`http://localhost:3011/jobStatus?job_id=${jobId}`);
      status = statusResponse.data.status;
      console.log(`Current status: ${status}`);
      
      if (status === 'completed') {
        // Get job logs
        const logsResponse = await axios.get(`http://localhost:3011/jobLog?job_id=${jobId}`);
        console.log('Job completed. Results:', JSON.stringify(logsResponse.data, null, 2));
        break;
      } else if (status === 'failed') {
        console.error('Job failed');
        break;
      } else if (status === 'action_required') {
        // Get job logs to see what information is needed
        const logsResponse = await axios.get(`http://localhost:3011/jobLog?job_id=${jobId}`);
        console.log('Action required. Current logs:', JSON.stringify(logsResponse.data, null, 2));
        
        // Provide additional information if needed
        const continueResponse = await axios.post('http://localhost:3011/continueKYB', {
          job_id: jobId,
          website: companyUrl
        });
        
        console.log('Provided additional information:', continueResponse.data);
        status = 'processing'; // Reset status to continue polling
      }
      
      // Wait 2 seconds before next poll
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    console.error('Error testing KYB service:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    } else if (error.request) {
      console.error('No response received. Is the server running?');
    } else {
      console.error('Error details:', error);
    }
  }
}

testKYBService(); 