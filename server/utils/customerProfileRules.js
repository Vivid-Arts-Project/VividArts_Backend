class CustomerProfileRuleError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_PROFILE') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeCustomerProfileUpdate(body, currentCustomer) {
  const fullName = String(body.fullName ?? currentCustomer.full_name ?? '').trim().replace(/\s+/g, ' ');
  const phoneNumber = String(body.phoneNumber ?? currentCustomer.phone_number ?? '').trim();
  const requestedUsername = String(body.username ?? currentCustomer.username ?? '').trim();
  const requestedEmail = String(body.email ?? currentCustomer.email ?? '').trim().toLowerCase();

  if (requestedUsername !== currentCustomer.username) {
    throw new CustomerProfileRuleError('Username is a permanent account identifier and cannot be changed here.', 400, 'USERNAME_CHANGE_NOT_ALLOWED');
  }
  if (requestedEmail !== String(currentCustomer.email || '').toLowerCase()) {
    throw new CustomerProfileRuleError('Email changes require a separate verification process.', 400, 'EMAIL_VERIFICATION_REQUIRED');
  }
  if (fullName.length < 2 || fullName.length > 100) {
    throw new CustomerProfileRuleError('Full name must be between 2 and 100 characters.');
  }
  if (phoneNumber && !/^[+\d][\d\s()-]{6,29}$/.test(phoneNumber)) {
    throw new CustomerProfileRuleError('Enter a valid phone number using 7 to 30 characters.');
  }
  return { full_name: fullName, phone_number: phoneNumber || null };
}

module.exports = { CustomerProfileRuleError, normalizeCustomerProfileUpdate };
