export function credentialDefaults(environment = process.env) {
  const result = {};
  for (const [field, names] of Object.entries({
    cloudToken: ['HCLOUD_TOKEN'], adminPassword: ['OBJY_ADMIN_PASSWORD'],
    accessKey: ['OBJY_S3_ACCESS_KEY', 'TF_VAR_s3_access_key'],
    secretKey: ['OBJY_S3_SECRET_KEY', 'TF_VAR_s3_secret_key'],
  })) {
    const value = names.map(name => environment[name]).find(value => typeof value === 'string' && value.length);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

export function withCredentials(values, environment = process.env) {
  const result = { ...values };
  for (const [key, value] of Object.entries(credentialDefaults(environment))) if (result[key] === undefined || result[key] === '') result[key] = value;
  return result;
}
