import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

export async function ensureShardMap(plan, secrets, {
  client,
  allowLegacyPeerReconcile = false,
  now = () => new Date().toISOString(),
} = {}) {
  const s3 = client || createClient(plan, secrets);
  await ensureBucket(s3, plan.persistence);
  const { key, historyPrefix } = shardMapLocation(plan);
  const current = await getJsonObject(s3, plan.persistence, key);
  const currentMap = current?.value?.shardMap || current?.value;

  if (currentMap) {
    const owner = current.value?.shardMap ? current.value.deployment : undefined;
    if (owner && owner !== plan.deployment) {
      throw new Error(`S3 shard map ${key} belongs to deployment "${owner}", not "${plan.deployment}"`);
    }
    if (sameShardMap(currentMap, plan.shardMap)) {
      if (!owner && current.etag) {
        await putJson(s3, plan.persistence, key, shardMapDocument(plan, now()), { IfMatch: current.etag });
      }
      return { key, created: false };
    }
    if ((owner === plan.deployment || allowLegacyPeerReconcile) && sameShardLayout(currentMap, plan.shardMap)) {
      const result = await replaceCurrentShardMap(s3, plan, current, key, historyPrefix, now);
      return { key, created: false, changed: true, historyKey: result.historyKey };
    }
    throw new Error(`S3 shard map ${key} differs from the requested topology; installation will not overwrite it`);
  }

  const body = JSON.stringify(shardMapDocument(plan, now()));
  try {
    await s3.send(new PutObjectCommand({
      Bucket: plan.persistence.bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 412 && error.name !== "PreconditionFailed") {
      throw s3RequestError(error, plan.persistence);
    }
    const raced = await getJson(s3, plan.persistence, key);
    if (!sameShardMap(raced?.shardMap || raced, plan.shardMap)) {
      throw new Error(`S3 shard map ${key} was created concurrently with a different topology`);
    }
  }
  return { key, created: true };
}

export async function replaceShardMap(plan, expectedMap, secrets, { client, expectedEtag, now = () => new Date().toISOString() } = {}) {
  const s3 = client || createClient(plan, secrets);
  await ensureBucket(s3, plan.persistence);
  const { key, historyPrefix } = shardMapLocation(plan);
  const current = await getJsonObject(s3, plan.persistence, key);
  const currentMap = current?.value?.shardMap || current?.value;
  const owner = current?.value?.shardMap ? current.value.deployment : undefined;
  if (owner && owner !== plan.deployment) {
    throw new Error(`S3 shard map ${key} belongs to deployment "${owner}", not "${plan.deployment}"`);
  }
  if (!current || !sameShardMap(currentMap, expectedMap)) {
    throw new Error(`S3 shard map ${key} changed since the topology operation was planned`);
  }
  if (expectedEtag && current.etag !== expectedEtag) throw new Error('S3 shard map revision changed since planning');
  if (sameShardMap(currentMap, plan.shardMap)) return { key, changed: false };
  const { historyKey } = await replaceCurrentShardMap(s3, plan, current, key, historyPrefix, now);
  return { key, historyKey, changed: true };
}

export async function readPublishedShardMap(plan, secrets, { client } = {}) {
  const result = await getJsonObject(client || createClient(plan, secrets), plan.persistence, shardMapLocation(plan).key);
  if (!result?.etag || result.value?.deployment !== plan.deployment) throw new Error('The saved shard map is missing or belongs to another installation');
  return { map: result.value.shardMap, etag: result.etag };
}

async function replaceCurrentShardMap(client, plan, current, key, historyPrefix, now) {
  if (!current.etag) throw new Error(`S3 shard map ${key} cannot be replaced safely because its ETag is unavailable`);
  const updatedAt = now();
  const historyKey = `${historyPrefix}/${updatedAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  await putJson(client, plan.persistence, historyKey, current.value, { IfNoneMatch: "*" });
  await putJson(client, plan.persistence, key, shardMapDocument(plan, updatedAt), { IfMatch: current.etag });
  return { historyKey };
}

function shardMapDocument(plan, updatedAt) {
  return {
    version: 1,
    deployment: plan.deployment,
    updatedAt,
    shardMap: plan.shardMap,
  };
}

function createClient(plan, secrets) {
  return new S3Client({
    region: plan.persistence.region,
    ...(plan.persistence.endpoint
      ? { endpoint: plan.persistence.endpoint, forcePathStyle: plan.persistence.forcePathStyle }
      : {}),
    credentials: {
      accessKeyId: secrets.s3AccessKeyId,
      secretAccessKey: secrets.s3SecretAccessKey,
    },
  });
}

async function ensureBucket(client, persistence) {
  const { bucket, endpoint, region } = persistence;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const missing = error.$metadata?.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchBucket";
    if (!missing) throw s3RequestError(error, persistence);
    try {
      await client.send(new CreateBucketCommand({
        Bucket: bucket,
        ...(region && region !== "us-east-1" ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}),
      }));
    } catch (createError) {
      throw s3RequestError(createError, { bucket, endpoint });
    }
  }
}

async function getJson(client, persistence, key) {
  return (await getJsonObject(client, persistence, key))?.value || null;
}

async function getJsonObject(client, persistence, key) {
  const { bucket } = persistence;
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return {
      value: JSON.parse(await response.Body.transformToString()),
      etag: response.ETag,
    };
  } catch (error) {
    const missing = error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey" || error.name === "NotFound";
    if (missing) return null;
    throw s3RequestError(error, persistence);
  }
}

async function putJson(client, persistence, key, value, conditions = {}) {
  try {
    await client.send(new PutObjectCommand({
      Bucket: persistence.bucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: "application/json",
      ...conditions,
    }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 412 || error.name === "PreconditionFailed") {
      throw new Error(`S3 shard map ${key} changed concurrently`);
    }
    throw s3RequestError(error, persistence);
  }
}

function s3RequestError(error, { bucket, endpoint }) {
  const status = error.$metadata?.httpStatusCode;
  const denied = status === 401 || status === 403 || ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(error.name);
  const location = endpoint ? ` at ${endpoint}` : "";
  const message = denied
    ? `S3 access denied for bucket "${bucket}"${location}; check the access key, secret key, region, and bucket permissions`
    : `S3 request failed for bucket "${bucket}"${location}${status ? ` (HTTP ${status})` : ""}: ${error.message || error.name || "unknown error"}`;
  return new Error(message, { cause: error });
}

function sameShardMap(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameShardLayout(left, right) {
  const describe = (map) => Object.entries(map?.shards || {})
    .map(([shard, value]) => [shard, Array.isArray(value?.peers) ? value.peers.length : -1])
    .sort(([leftShard], [rightShard]) => leftShard.localeCompare(rightShard));
  return JSON.stringify(describe(left)) === JSON.stringify(describe(right));
}

function shardMapLocation(plan) {
  const store = plan.database?.cluster?.shardMapStore || {};
  const prefix = String(store.prefix || plan.persistence.prefix).replace(/^\/+|\/+$/g, "");
  const relativeKey = String(store.key || "cluster/shard-map.json").replace(/^\/+/, "");
  const separator = relativeKey.lastIndexOf("/");
  const directory = separator >= 0 ? relativeKey.slice(0, separator) : "";
  return {
    key: `${prefix}/${relativeKey}`,
    historyPrefix: `${prefix}/${directory ? `${directory}/` : ""}shard-map-history`,
  };
}
