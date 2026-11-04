import { CreateBucketCommand, DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from 'node:crypto';

export async function waitForS3Bucket(plan, environment, {
  create = false,
  probeWrite = false,
  createClient = (configuration) => new S3Client(configuration),
  timeoutMs = 60_000,
  retryMs = 500,
} = {}) {
  const credentials = plan.persistence.credentials;
  const client = createClient({
    endpoint: plan.persistence.endpoint,
    region: plan.persistence.region,
    forcePathStyle: plan.persistence.forcePathStyle,
    credentials: {
      accessKeyId: environment[credentials.accessKeyId.fromEnvironment],
      secretAccessKey: environment[credentials.secretAccessKey.fromEnvironment],
    },
  });
  const input = { Bucket: plan.persistence.bucket };
  const deadline = Date.now() + timeoutMs;
  const probeKey = `${plan.persistence.prefix}/_control/readiness-${randomUUID()}`;
  let latest;
  let created = false;
  try {
    while (Date.now() < deadline) {
      try {
        await client.send(new HeadBucketCommand(input));
        if (probeWrite) {
          await client.send(new PutObjectCommand({ ...input, Key: probeKey, Body: 'ready' }));
          await client.send(new DeleteObjectCommand({ ...input, Key: probeKey }));
        }
        return;
      } catch (error) {
        latest = error;
      }
      if (create && !created) {
        try {
          await client.send(new CreateBucketCommand(input));
          created = true;
        } catch (error) {
          latest = error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    throw new Error(`object storage did not become ready: ${latest?.message || "unknown error"}`);
  } finally { client.destroy?.(); }
}
