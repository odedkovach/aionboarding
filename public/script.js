// API Configuration
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:3011' 
    : '';  // Production URL (same origin)

// DOM Elements
const searchForm = document.getElementById('search-form');
const verificationProgress = document.getElementById('verification-progress');
const verificationResults = document.getElementById('verification-results');
const actionRequired = document.getElementById('action-required');
const errorCard = document.getElementById('error-card');
const businessNameInput = document.getElementById('business_name');
const startVerificationBtn = document.getElementById('start-verification-btn');
const companyNameSpan = document.getElementById('company-name');
const resultCompanyNameSpan = document.getElementById('result-company-name');
const actionMessage = document.getElementById('action-message');
const actionForm = document.getElementById('action-form');
const continueVerificationBtn = document.getElementById('continue-verification-btn');
const errorMessage = document.getElementById('error-message');
const tryAgainBtn = document.getElementById('try-again-btn');
const startNewVerificationBtn = document.getElementById('start-new-verification');

// State
let currentJobId = null;
let currentBusinessName = '';
let pollingInterval = null;
let progressSteps = {
    'crn': { step: 'Company Registration Number', element: document.querySelector('[data-step="crn"]') },
    'company_details': { step: 'Company Details', element: document.querySelector('[data-step="company_details"]') },
    'officers': { step: 'Officers & PSC', element: document.querySelector('[data-step="officers"]') },
    'website': { step: 'Website Information', element: document.querySelector('[data-step="website"]') },
    'incorporation': { step: 'Incorporation Document', element: document.querySelector('[data-step="incorporation"]') },
    'final': { step: 'Final Verification', element: document.querySelector('[data-step="final"]') }
};

// Event Listeners
startVerificationBtn.addEventListener('click', startVerification);
continueVerificationBtn.addEventListener('click', continueVerification);
tryAgainBtn.addEventListener('click', resetForm);
startNewVerificationBtn.addEventListener('click', resetForm);

// Functions
async function startVerification() {
    const businessName = businessNameInput.value.trim();
    
    if (!businessName) {
        showError('Please enter a business name');
        return;
    }
    
    currentBusinessName = businessName;
    companyNameSpan.textContent = businessName;
    
    try {
        showCard(verificationProgress);
        resetProgress();
        
        // Make API call to start verification
        const response = await fetch(`${API_URL}/startKYB`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ business_name: businessName })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to start verification');
        }
        
        currentJobId = data.job_id;
        
        // Start polling for status updates
        startPolling();
        
    } catch (error) {
        showError(error.message);
    }
}

async function continueVerification() {
    if (!currentJobId) {
        showError('No active verification process');
        return;
    }
    
    // Collect additional information from form
    const formData = {};
    const inputs = actionForm.querySelectorAll('input');
    inputs.forEach(input => {
        if (input.value.trim()) {
            formData[input.name] = input.value.trim();
        }
    });
    
    if (Object.keys(formData).length === 0) {
        showError('Please provide the required information');
        return;
    }
    
    try {
        showCard(verificationProgress);
        
        // Update current step status
        const currentStep = document.querySelector('.progress-step .progress-indicator.active');
        if (currentStep) {
            const statusEl = currentStep.parentElement.querySelector('.status');
            statusEl.textContent = 'Processing with new information...';
            statusEl.className = 'status processing';
        }
        
        // Make API call to continue verification
        const response = await fetch(`${API_URL}/continueKYB`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                job_id: currentJobId,
                ...formData
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to continue verification');
        }
        
        // Restart polling for status updates
        startPolling();
        
    } catch (error) {
        showError(error.message);
    }
}

function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    
    // Poll for status updates every 2 seconds
    pollingInterval = setInterval(async () => {
        try {
            await checkJobStatus();
        } catch (error) {
            clearInterval(pollingInterval);
            showError(error.message);
        }
    }, 2000);
    
    // Initial check
    checkJobStatus();
}

async function checkJobStatus() {
    if (!currentJobId) return;
    
    // Get job status
    const statusResponse = await fetch(`${API_URL}/jobStatus?job_id=${currentJobId}`);
    const statusData = await statusResponse.json();
    
    if (!statusResponse.ok) {
        clearInterval(pollingInterval);
        throw new Error(statusData.error || 'Failed to check job status');
    }
    
    const status = statusData.status;
    
    // Get job log
    const logResponse = await fetch(`${API_URL}/jobLog?job_id=${currentJobId}`);
    
    if (!logResponse.ok) {
        clearInterval(pollingInterval);
        throw new Error('Failed to fetch job log');
    }
    
    const logData = await logResponse.json();
    
    // Update progress based on status
    updateProgress(status, logData);
    
    // Handle different status outcomes
    if (status === 'completed') {
        clearInterval(pollingInterval);
        showResults(logData);
    } else if (status === 'failed') {
        clearInterval(pollingInterval);
        const error = typeof logData === 'object' && logData.error ? logData.error : 'Verification failed';
        showError(error);
    } else if (status === 'action_required') {
        clearInterval(pollingInterval);
        showActionRequired(logData);
    }
}

function updateProgress(status, logData) {
    // Reset all steps first
    Object.values(progressSteps).forEach(({ element }) => {
        const indicator = element.querySelector('.progress-indicator');
        const statusEl = element.querySelector('.status');
        
        indicator.classList.remove('active', 'completed');
        statusEl.textContent = 'Waiting...';
        statusEl.className = 'status';
    });
    
    // Figure out which step we're on based on log data
    let currentStep = null;
    let completedSteps = [];
    
    // Populate the logs container with detailed information
    const logsContainer = document.getElementById('progress-logs-container');
    
    // Clear the logs container and add the initial entry
    if (Array.isArray(logData) && logData.length > 0) {
        logsContainer.innerHTML = ''; // Clear previous logs
        
        // Sort logs by timestamp if available
        const sortedLogs = [...logData].sort((a, b) => {
            if (a.timestamp && b.timestamp) {
                return new Date(a.timestamp) - new Date(b.timestamp);
            }
            return 0; // Keep original order if no timestamps
        });
        
        // Add each log entry to the UI with appropriate styling
        sortedLogs.forEach(entry => {
            // Determine log type based on content
            let logType = 'info';
            if (entry.step.includes('Error') || entry.error) {
                logType = 'error';
            } else if (entry.step.includes('Validation') || entry.step.includes('Cross-Validation')) {
                if (entry.data && entry.data.match === false) {
                    logType = 'warning';
                } else if (entry.data && entry.data.match === true) {
                    logType = 'success';
                }
            } else if (entry.step.includes('Complete')) {
                logType = 'success';
            }
            
            // Format the timestamp if available
            let timestamp = '';
            if (entry.timestamp) {
                const date = new Date(entry.timestamp);
                timestamp = `<span class="timestamp">${date.toLocaleTimeString()}</span>`;
            }
            
            // Format the message based on step and data
            let message = `<span class="step">${entry.step}:</span>`;
            
            if (entry.error) {
                message += ` Error: ${entry.error}`;
            } else if (entry.message) {
                message += ` ${entry.message}`;
            } else if (entry.data) {
                if (typeof entry.data === 'string') {
                    message += ` ${entry.data}`;
                } else if (entry.step === 'Company Name Comparison') {
                    message += ` Website: "${entry.data.website_name}" vs Companies House: "${entry.data.companies_house_name}" (Match: ${entry.data.match ? 'Yes' : 'No'}, Similarity: ${entry.data.similarity_score})`;
                } else if (entry.step === 'Website CRN Validation') {
                    message += ` ${entry.data.crn_found ? `Found CRN: ${entry.data.crn_found}` : 'No CRN found on website'}`;
                } else if (entry.step === 'CRN Cross-Validation') {
                    message += ` Website CRN: ${entry.data.website_crn}, Companies House CRN: ${entry.data.api_crn} (Match: ${entry.data.match ? 'Yes' : 'No'})`;
                } else if (entry.step === 'Additional AI Request') {
                    message += ` ${entry.data.message}`;
                } else if (entry.step === 'Additional AI Response') {
                    message += ` ${entry.data.crn ? `Found alternative CRN: ${entry.data.crn}` : 'No alternative CRN found'}`;
                }
            }
            
            // Create and add the log entry element
            const logEntry = document.createElement('p');
            logEntry.className = `log-entry ${logType}`;
            logEntry.innerHTML = `${timestamp}${message}`;
            logsContainer.appendChild(logEntry);
            
            // Scroll to the bottom to show latest logs
            logsContainer.scrollTop = logsContainer.scrollHeight;
        });
    }
    
    // Existing code to determine progress steps
    if (Array.isArray(logData)) {
        // Check the log entries to determine progress
        for (const entry of logData) {
            if (entry.step === 'Original Request') {
                // Starting point
                currentStep = 'crn';
            } else if (entry.step === 'GPT Result' || entry.step === 'GPT Error') {
                // Working on finding CRN
                currentStep = 'crn';
            } else if (entry.step === 'Companies House Profile') {
                // Got company details
                completedSteps.push('crn');
                currentStep = 'company_details';
            } else if (entry.step === 'New Company GPT Result') {
                // Retrying with new company name
                currentStep = 'crn';
            } else if (entry.step === 'Website CRN Validation' || entry.step === 'CRN Cross-Validation' || entry.step === 'Company Name Comparison') {
                // Show validation is happening
                completedSteps.push('crn', 'company_details');
                currentStep = 'website';
                
                // Add detailed status for website step
                const websiteStepEl = progressSteps['website'].element.querySelector('.status');
                if (websiteStepEl) {
                    if (entry.step === 'Website CRN Validation') {
                        websiteStepEl.textContent = 'Validating CRN on website...';
                    } else if (entry.step === 'CRN Cross-Validation') {
                        if (entry.data && entry.data.match) {
                            websiteStepEl.textContent = 'CRN validated ✓';
                            websiteStepEl.className = 'status completed';
                        } else {
                            websiteStepEl.textContent = 'CRN validation warning';
                            websiteStepEl.className = 'status error';
                        }
                    } else if (entry.step === 'Company Name Comparison') {
                        if (entry.data && entry.data.match) {
                            websiteStepEl.textContent = 'Company name validated ✓';
                            websiteStepEl.className = 'status completed';
                        } else {
                            websiteStepEl.textContent = 'Company name mismatch';
                            websiteStepEl.className = 'status error';
                        }
                    }
                }
            } else if (entry.step === 'Additional AI Request' || entry.step === 'Additional AI Response') {
                // Additional AI requests for company name mismatch
                const websiteStepEl = progressSteps['website'].element.querySelector('.status');
                if (websiteStepEl) {
                    websiteStepEl.textContent = 'Validating alternative company name...';
                    websiteStepEl.className = 'status processing';
                }
            } else if (entry.step.includes('Officers') || entry.step.includes('Beneficial Owners')) {
                // Working on officers and PSC
                completedSteps.push('crn', 'company_details');
                currentStep = 'officers';
            } else if (entry.step.includes('Website')) {
                // Working on website info
                completedSteps.push('crn', 'company_details', 'officers');
                currentStep = 'website';
            } else if (entry.step.includes('Incorporation')) {
                // Working on incorporation document
                completedSteps.push('crn', 'company_details', 'officers', 'website');
                currentStep = 'incorporation';
            } else if (entry.step === 'Final Result') {
                // Finished all steps
                completedSteps.push('crn', 'company_details', 'officers', 'website', 'incorporation');
                currentStep = 'final';
            } else if (entry.step === 'Action Required') {
                // Check if we have required_fields to determine where we are
                if (entry.required_fields && entry.required_fields.crn) {
                    currentStep = 'crn';
                }
            }
        }
    }
    
    // Mark completed steps
    completedSteps.forEach(step => {
        if (progressSteps[step]) {
            const { element } = progressSteps[step];
            const indicator = element.querySelector('.progress-indicator');
            const statusEl = element.querySelector('.status');
            
            indicator.classList.add('completed');
            // Add a checkmark icon
            indicator.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
            statusEl.textContent = 'Completed';
            statusEl.className = 'status completed';
        }
    });
    
    // Mark current step as active
    if (currentStep && progressSteps[currentStep]) {
        const { element } = progressSteps[currentStep];
        const indicator = element.querySelector('.progress-indicator');
        const statusEl = element.querySelector('.status');
        
        indicator.classList.add('active');
        
        // Different status based on overall job status
        if (status === 'processing') {
            indicator.innerHTML = '<div class="loading-spinner"></div>';
            statusEl.textContent = 'Processing...';
            statusEl.className = 'status processing';
        } else if (status === 'action_required') {
            indicator.innerHTML = '!';
            statusEl.textContent = 'Action required';
            statusEl.className = 'status error';
        } else if (status === 'failed') {
            indicator.innerHTML = '×';
            statusEl.textContent = 'Failed';
            statusEl.className = 'status error';
        }
    }
}

function showResults(data) {
    // Add debug logs to understand the data structure
    console.log("Received data in showResults:", data);
    
    // Try to find the result object in different possible locations
    let resultData = null;
    
    if (data.result) {
        console.log("Found data.result");
        resultData = data.result;
    } else if (data.log_entries && data.log_entries.length > 0) {
        // Try to find the completion entry in log_entries
        console.log("Searching in log_entries...");
        for (const entry of data.log_entries) {
            if (entry.step === 'Completed' && entry.result) {
                console.log("Found completion entry with result");
                resultData = entry.result;
                break;
            }
        }
    }
    
    console.log("Using resultData:", resultData);
    
    // Use resultData if found, otherwise fallback to original data
    const displayData = resultData || data;
    
    // Populate result fields
    if (typeof displayData === 'object') {
        // Company request name
        document.getElementById('result-company-name').textContent = currentBusinessName;
        
        // Main company details
        document.getElementById('result-company-name-value').textContent = displayData.company_name || 'N/A';
        document.getElementById('result-crn').textContent = displayData.company_registration_number || 'N/A';
        document.getElementById('result-company-type').textContent = displayData.company_type || 'N/A';
        document.getElementById('result-company-status').textContent = displayData.company_status || 'N/A';
        document.getElementById('result-incorporation-date').textContent = displayData.incorporation_date || 'N/A';
        document.getElementById('result-jurisdiction').textContent = displayData.jurisdiction || 'N/A';

        // Business details
        if (displayData.business) {
            document.getElementById('result-business-age').textContent = displayData.business.businessAge || 'N/A';
            document.getElementById('result-business-category').textContent = displayData.business.category || 'N/A';
        } else {
            document.getElementById('result-business-age').textContent = 'N/A';
            document.getElementById('result-business-category').textContent = 'N/A';
        }

        // SIC codes
        if (displayData.sicCodes && displayData.sicCodes.length > 0) {
            document.getElementById('result-sic-codes').textContent = displayData.sicCodes.join(', ');
        } else if (displayData.nature_of_business && displayData.nature_of_business.length > 0) {
            document.getElementById('result-sic-codes').textContent = displayData.nature_of_business.join(', ');
        } else {
            document.getElementById('result-sic-codes').textContent = 'N/A';
        }
        
        // Website - make it a link if available
        const websiteElement = document.getElementById('result-website');
        if (displayData.website_url) {
            websiteElement.innerHTML = `<a href="${displayData.website_url}" target="_blank" rel="noopener noreferrer">${displayData.website_url}</a>`;
        } else {
            websiteElement.textContent = 'N/A';
        }

        // Companies House profile link
        const chProfileElement = document.getElementById('result-ch-profile');
        if (displayData.companies_house_profile_url) {
            chProfileElement.innerHTML = `<a href="${displayData.companies_house_profile_url}" target="_blank" rel="noopener noreferrer">${displayData.companies_house_profile_url}</a>`;
        } else {
            chProfileElement.textContent = 'N/A';
        }
        
        // Previous Company Names
        if (displayData.raw_data && 
            displayData.raw_data.companies_house_profile && 
            displayData.raw_data.companies_house_profile.previous_company_names && 
            displayData.raw_data.companies_house_profile.previous_company_names.length > 0) {
            
            const previousNamesSection = document.getElementById('previous-names-section');
            const previousNamesElement = document.getElementById('result-previous-names');
            previousNamesSection.classList.remove('hidden');
            previousNamesElement.innerHTML = '';
            
            displayData.raw_data.companies_house_profile.previous_company_names.forEach(prevName => {
                const nameElement = document.createElement('div');
                nameElement.className = 'list-item';
                nameElement.innerHTML = `<strong>${prevName.name}</strong> (${prevName.effective_from} to ${prevName.ceased_on})`;
                previousNamesElement.appendChild(nameElement);
            });
        }
        
        // Format address
        const addressElement = document.getElementById('result-registered-address');
        if (displayData.registered_address) {
            const addr = displayData.registered_address;
            const addressParts = [
                addr.address_line_1,
                addr.address_line_2,
                addr.locality,
                addr.region,
                addr.postal_code,
                addr.country
            ].filter(Boolean);
            
            addressElement.textContent = addressParts.join(', ');
        } else {
            addressElement.textContent = 'N/A';
        }

        // Business/Operational address
        const businessAddressElement = document.getElementById('result-business-address');
        if (displayData.business_address) {
            const addr = displayData.business_address;
            const addressParts = [
                addr.address_line_1,
                addr.address_line_2,
                addr.locality,
                addr.region,
                addr.postal_code,
                addr.country
            ].filter(Boolean);
            
            businessAddressElement.textContent = addressParts.join(', ');
        } else {
            businessAddressElement.textContent = 'Same as registered address';
        }

        // Contact Information
        document.getElementById('result-phone').textContent = displayData.contact_phone || 'N/A';
        document.getElementById('result-email').textContent = displayData.contact_email || 'N/A';

        // Additional company details
        document.getElementById('result-has-insolvency').textContent = 
            displayData.hasInsolvencyHistory || displayData.has_insolvency_history ? 'Yes' : 'No';
        document.getElementById('result-has-charges').textContent = 
            displayData.hasCharges || displayData.has_charges ? 'Yes' : 'No';
        document.getElementById('result-can-file').textContent = 
            displayData.canFile || displayData.can_file ? 'Yes' : 'No';

        // Financial Information
        if (displayData.raw_data && displayData.raw_data.companies_house_profile && displayData.raw_data.companies_house_profile.accounts) {
            const accounts = displayData.raw_data.companies_house_profile.accounts;
            
            // Last accounts
            if (accounts.last_accounts) {
                document.getElementById('result-last-accounts-date').textContent = accounts.last_accounts.made_up_to || 'N/A';
                document.getElementById('result-last-accounts-type').textContent = accounts.last_accounts.type || 'N/A';
            } else {
                document.getElementById('result-last-accounts-date').textContent = 'N/A';
                document.getElementById('result-last-accounts-type').textContent = 'N/A';
            }
            
            // Next accounts
            document.getElementById('result-next-accounts-due').textContent = accounts.next_due || 'N/A';
            
            // Last full members list
            document.getElementById('result-last-members-list').textContent = 
                displayData.lastFullMembersListDate || displayData.last_full_members_list_date || 
                (displayData.raw_data.companies_house_profile.last_full_members_list_date || 'N/A');
            
            // Confirmation statement
            if (displayData.raw_data.companies_house_profile.confirmation_statement) {
                const confStatement = displayData.raw_data.companies_house_profile.confirmation_statement;
                document.getElementById('result-confirmation-statement-date').textContent = 
                    confStatement.last_made_up_to || 'N/A';
                document.getElementById('result-next-confirmation-due').textContent = 
                    confStatement.next_due || 'N/A';
            } else {
                document.getElementById('result-confirmation-statement-date').textContent = 'N/A';
                document.getElementById('result-next-confirmation-due').textContent = 'N/A';
            }
        } else {
            document.getElementById('result-last-accounts-date').textContent = 'N/A';
            document.getElementById('result-last-accounts-type').textContent = 'N/A';
            document.getElementById('result-next-accounts-due').textContent = 'N/A';
            document.getElementById('result-last-members-list').textContent = 'N/A';
            document.getElementById('result-confirmation-statement-date').textContent = 'N/A';
            document.getElementById('result-next-confirmation-due').textContent = 'N/A';
        }
        
        // Display validation results
        if (displayData.verification_details) {
            // CRN validation
            updateValidationItem(
                'crn-validation',
                displayData.verification_details.crn_validation.status,
                displayData.verification_details.crn_validation.message
            );
            
            // Set CRN values for comparison
            document.getElementById('ch-crn-value').textContent = displayData.company_registration_number || 'N/A';
            
            const websiteCrnValue = document.getElementById('website-crn-value');
            if (displayData.website_validation && displayData.website_validation.crn_found) {
                websiteCrnValue.textContent = displayData.website_validation.crn_found;
                
                // Add match/mismatch styling
                if (displayData.website_validation.crn_match) {
                    websiteCrnValue.classList.add('match');
                } else {
                    websiteCrnValue.classList.add('mismatch');
                }
            } else {
                websiteCrnValue.textContent = 'Not found';
            }
            
            // Address validation
            updateValidationItem(
                'address-validation',
                displayData.verification_details.address_validation.status,
                displayData.verification_details.address_validation.message
            );
            
            // Website data validation
            updateValidationItem(
                'website-validation',
                displayData.verification_details.website_data.status,
                displayData.verification_details.website_data.message
            );
            
            // Display detailed website data if available
            const websiteDataDetails = document.getElementById('website-data-details');
            const websiteDataList = document.getElementById('website-data-list');
            
            if (displayData.website_validation && displayData.website_validation.scrape_data) {
                websiteDataDetails.classList.remove('hidden');
                websiteDataList.innerHTML = '';
                
                // Add all the found website data to the list
                Object.entries(displayData.website_validation.scrape_data).forEach(([key, value]) => {
                    if (value) {
                        const listItem = document.createElement('li');
                        listItem.textContent = `${key.replace(/_/g, ' ')}: ${value}`;
                        websiteDataList.appendChild(listItem);
                    }
                });
                
                // If no data items were added, show a message
                if (websiteDataList.children.length === 0) {
                    const listItem = document.createElement('li');
                    listItem.textContent = 'No detailed website data available';
                    websiteDataList.appendChild(listItem);
                }
            } else {
                websiteDataDetails.classList.add('hidden');
            }
            
            // Display validation issues if there are any
            const validationIssues = document.getElementById('validation-issues');
            const validationIssuesList = document.getElementById('validation-issues-list');
            
            // Check if we have validation issues
            if (displayData.verification_status && displayData.verification_status.includes('warning') || 
                (displayData.validation_issues && displayData.validation_issues.length > 0)) {
                validationIssues.classList.remove('hidden');
                validationIssuesList.innerHTML = '';
                
                // Add all validation issues to the list
                if (displayData.validation_issues && displayData.validation_issues.length > 0) {
                    displayData.validation_issues.forEach(issue => {
                        const listItem = document.createElement('li');
                        listItem.textContent = issue;
                        validationIssuesList.appendChild(listItem);
                    });
                } 
                // If CRN validation failed but no explicit issues listed
                else if (displayData.verification_details.crn_validation.status === 'unverified' || 
                        displayData.verification_details.crn_validation.status === 'pending') {
                    const listItem = document.createElement('li');
                    listItem.textContent = displayData.verification_details.crn_validation.message;
                    validationIssuesList.appendChild(listItem);
                }
                // If website data validation has issues
                else if (displayData.verification_details.website_data.status !== 'verified') {
                    const listItem = document.createElement('li');
                    listItem.textContent = displayData.verification_details.website_data.message;
                    validationIssuesList.appendChild(listItem);
                }
                // Fallback if no specific issues found
                else {
                    const listItem = document.createElement('li');
                    listItem.textContent = 'Validation warning - some verification checks did not pass';
                    validationIssuesList.appendChild(listItem);
                }
            } else {
                validationIssues.classList.add('hidden');
            }
        } else {
            // Handle legacy data format
            hideValidationSection();
        }
        
        // Officers
        const officersElement = document.getElementById('result-officers');
        officersElement.innerHTML = '';
        
        if (displayData.directors && displayData.directors.length > 0) {
            displayData.directors.forEach(officer => {
                const officerElement = document.createElement('div');
                officerElement.className = 'list-item';
                officerElement.textContent = officer;
                officersElement.appendChild(officerElement);
            });
        } else {
            officersElement.innerHTML = '<p>No officers found</p>';
        }
        
        // Beneficial Owners
        const ownersElement = document.getElementById('result-owners');
        ownersElement.innerHTML = '';
        
        if (displayData.beneficial_owners && displayData.beneficial_owners.length > 0) {
            displayData.beneficial_owners.forEach(owner => {
                const ownerElement = document.createElement('div');
                ownerElement.className = 'list-item';
                
                const nameSpan = document.createElement('span');
                nameSpan.textContent = owner.name;
                nameSpan.style.fontWeight = '500';
                
                const percentSpan = document.createElement('span');
                percentSpan.textContent = ` - ${owner.ownership_percent || 'Ownership percentage not specified'}`;
                
                // Add date of birth if available
                if (owner.date_of_birth) {
                    percentSpan.textContent += ` (Born: ${owner.date_of_birth})`;
                }
                
                ownerElement.appendChild(nameSpan);
                ownerElement.appendChild(percentSpan);
                
                ownersElement.appendChild(ownerElement);
            });
        } else {
            ownersElement.innerHTML = '<p>No beneficial owners found</p>';
        }
        
        // Verification status
        const statusBadge = document.getElementById('verification-status-badge');
        const statusMessage = document.getElementById('verification-status-message');
        const statusContainer = document.querySelector('.verification-status');
        
        if (displayData.verification_status && displayData.verification_status.includes('warning')) {
            statusBadge.textContent = 'Warning';
            statusBadge.className = 'badge warning';
            statusMessage.textContent = displayData.verification_status;
            statusContainer.className = 'verification-status warning';
        } else {
            statusBadge.textContent = 'Verified';
            statusBadge.className = 'badge';
            statusMessage.textContent = 'All verification checks passed successfully';
            statusContainer.className = 'verification-status';
        }
    }
    
    showCard(verificationResults);
}

// Helper functions for validation display
function updateValidationItem(id, status, message) {
    const item = document.getElementById(id);
    if (!item) return;
    
    const statusElement = item.querySelector('.validation-status');
    const messageElement = item.querySelector('.validation-message');
    
    // Update status
    statusElement.textContent = capitalizeFirstLetter(status);
    statusElement.className = 'validation-status ' + status;
    
    // Update message
    messageElement.textContent = message;
}

function hideValidationSection() {
    const validationSection = document.querySelector('.result-section:nth-child(2)');
    if (validationSection) {
        validationSection.style.display = 'none';
    }
}

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function showActionRequired(data) {
    let message = 'Additional information is required to continue the verification.';
    let requiredFields = {};
    
    // Find the action required message in the log
    if (Array.isArray(data)) {
        for (let i = data.length - 1; i >= 0; i--) {
            const entry = data[i];
            if (entry.step === 'Action Required') {
                message = entry.message || message;
                requiredFields = entry.required_fields || {};
                break;
            }
        }
    }
    
    // Set message
    actionMessage.textContent = message;
    
    // Clear previous form fields
    actionForm.innerHTML = '';
    
    // Add form fields for required information
    Object.entries(requiredFields).forEach(([field, description]) => {
        const fieldGroup = document.createElement('div');
        fieldGroup.className = 'form-group';
        
        const label = document.createElement('label');
        label.textContent = description;
        label.htmlFor = `action-${field}`;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.id = `action-${field}`;
        input.name = field;
        input.placeholder = `Enter ${description.toLowerCase()}`;
        
        fieldGroup.appendChild(label);
        fieldGroup.appendChild(input);
        actionForm.appendChild(fieldGroup);
    });
    
    showCard(actionRequired);
}

function showError(message) {
    errorMessage.textContent = message || 'An error occurred during the verification process';
    showCard(errorCard);
}

function resetProgress() {
    // Reset all steps
    Object.values(progressSteps).forEach(({ element }) => {
        const indicator = element.querySelector('.progress-indicator');
        const statusEl = element.querySelector('.status');
        
        indicator.classList.remove('active', 'completed');
        
        // Reset first step to active
        if (element.dataset.step === 'crn') {
            indicator.classList.add('active');
            indicator.innerHTML = '<div class="loading-spinner"></div>';
            statusEl.textContent = 'Processing...';
            statusEl.className = 'status processing';
        } else {
            if (element.dataset.step === 'company_details') {
                indicator.innerHTML = '<div class="step-number">2</div>';
            } else if (element.dataset.step === 'officers') {
                indicator.innerHTML = '<div class="step-number">3</div>';
            } else if (element.dataset.step === 'website') {
                indicator.innerHTML = '<div class="step-number">4</div>';
            } else if (element.dataset.step === 'incorporation') {
                indicator.innerHTML = '<div class="step-number">5</div>';
            } else if (element.dataset.step === 'final') {
                indicator.innerHTML = '<div class="step-number">6</div>';
            }
            
            statusEl.textContent = 'Waiting...';
            statusEl.className = 'status';
        }
    });
}

function resetForm() {
    // Clear state
    currentJobId = null;
    currentBusinessName = '';
    
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    
    // Reset form
    businessNameInput.value = '';
    
    // Show initial form
    showCard(searchForm);
}

function showCard(cardToShow) {
    // Hide all cards
    searchForm.classList.add('hidden');
    verificationProgress.classList.add('hidden');
    verificationResults.classList.add('hidden');
    actionRequired.classList.add('hidden');
    errorCard.classList.add('hidden');
    
    // Show selected card
    cardToShow.classList.remove('hidden');
} 