export const S3_ACCESS_KEY_ENV = "OBJYDB_S3_ACCESS_KEY";
export const S3_SECRET_KEY_ENV = "OBJYDB_S3_SECRET_KEY";

export function s3StoragePlan(driver, settings, {
  managed = false,
  runtimeEndpoint = settings.endpoint,
  targetExtensions,
} = {}) {
  return {
    driver,
    managed,
    endpoint: url(settings.endpoint, `${driver}.endpoint`),
    runtimeEndpoint: url(runtimeEndpoint, `${driver}.runtimeEndpoint`),
    region: requiredString(settings.region, `${driver}.region`),
    bucket: bucketName(settings.bucket, `${driver}.bucket`),
    prefix: cleanPrefix(settings.prefix, `${driver}.prefix`),
    forcePathStyle: Boolean(settings.forcePathStyle),
    credentials: {
      accessKeyId: secretReference(settings.accessKeyId, `${driver}.accessKeyId`, S3_ACCESS_KEY_ENV),
      secretAccessKey: secretReference(settings.secretAccessKey, `${driver}.secretAccessKey`, S3_SECRET_KEY_ENV),
    },
    ...(targetExtensions ? { targetExtensions } : {}),
  };
}

export function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function optionalString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function positiveInteger(value, label, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

export function port(value, label, fallback) {
  const number = positiveInteger(value, label, fallback);
  if (number > 65535) throw new Error(`${label} must be at most 65535`);
  return number;
}

export function cleanPrefix(value, label = "storage prefix") {
  const prefix = requiredString(value, label).replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error(`${label} must not be empty`);
  return prefix;
}

export function bucketName(value, label) {
  const bucket = requiredString(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`${label} must be a valid S3 bucket name`);
  }
  return bucket;
}

export function secretReference(value, label, fallbackEnvironment) {
  const reference = value === undefined ? { fromEnvironment: fallbackEnvironment } : value;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error(`${label} must be a secret reference`);
  }
  const fromEnvironment = requiredString(reference.fromEnvironment, `${label}.fromEnvironment`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(fromEnvironment)) {
    throw new Error(`${label}.fromEnvironment must be an environment variable name`);
  }
  return { fromEnvironment };
}

function url(value, label) {
  const endpoint = requiredString(value, label);
  try { return new URL(endpoint).toString().replace(/\/$/, ""); }
  catch { throw new Error(`${label} must be a valid URL`); }
}
