export function resolvePlanSecrets(plan, environment = process.env) {
  const read = (reference, label) => {
    const name = reference.fromEnvironment;
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`required secret is missing: ${name} (${label})`);
    }
    return value;
  };

  const admin = plan.database.auth.users.find((user) => user.admin === true) || plan.database.auth.users[0];
  return {
    s3AccessKeyId: read(plan.persistence.credentials.accessKeyId, "S3 access key"),
    s3SecretAccessKey: read(plan.persistence.credentials.secretAccessKey, "S3 secret key"),
    jwtSecret: read(plan.database.auth.jwtSecret, "JWT secret"),
    clusterSecret: read(plan.database.cluster.secret, "cluster secret"),
    adminPassword: read(admin.password, "admin password"),
  };
}

export function secretEnvironmentNames(value) {
  const names = new Set();
  visit(value);
  return [...names];

  function visit(current) {
    if (!current || typeof current !== "object") return;
    if (!Array.isArray(current) && Object.keys(current).length === 1 && typeof current.fromEnvironment === "string") {
      names.add(current.fromEnvironment);
      return;
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) visit(child);
  }
}
