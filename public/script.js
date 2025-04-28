// API Configuration
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:3010' 
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
    // Populate result fields
    if (typeof data === 'object') {
        document.getElementById('result-company-name').textContent = currentBusinessName;
        document.getElementById('result-company-name-value').textContent = data.company_name || 'N/A';
        document.getElementById('result-crn').textContent = data.company_registration_number || 'N/A';
        document.getElementById('result-company-type').textContent = data.company_type || 'N/A';
        document.getElementById('result-company-status').textContent = data.company_status || 'N/A';
        document.getElementById('result-incorporation-date').textContent = data.incorporation_date || 'N/A';
        
        // Website - make it a link if available
        const websiteElement = document.getElementById('result-website');
        if (data.website_url) {
            websiteElement.innerHTML = `<a href="${data.website_url}" target="_blank" rel="noopener noreferrer">${data.website_url}</a>`;
        } else {
            websiteElement.textContent = 'N/A';
        }
        
        // Format address
        const addressElement = document.getElementById('result-registered-address');
        if (data.registered_address) {
            const addr = data.registered_address;
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
        
        // Officers
        const officersElement = document.getElementById('result-officers');
        officersElement.innerHTML = '';
        
        if (data.directors && data.directors.length > 0) {
            data.directors.forEach(officer => {
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
        
        if (data.beneficial_owners && data.beneficial_owners.length > 0) {
            data.beneficial_owners.forEach(owner => {
                const ownerElement = document.createElement('div');
                ownerElement.className = 'list-item';
                
                const nameSpan = document.createElement('span');
                nameSpan.textContent = owner.name;
                nameSpan.style.fontWeight = '500';
                
                const percentSpan = document.createElement('span');
                percentSpan.textContent = ` - ${owner.ownership_percent || 'Ownership percentage not specified'}`;
                
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
        
        if (data.verification_status && data.verification_status.includes('warning')) {
            statusBadge.textContent = 'Warning';
            statusBadge.className = 'badge warning';
            statusMessage.textContent = data.verification_status;
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