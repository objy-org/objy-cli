export function createDeploymentPlan(manifest, { materializeNode, shardRevision = 1 } = {}) {
  if (typeof materializeNode !== "function") {
    throw new Error("target driver must materialize deployment nodes");
  }

  const { shards, replicas } = manifest.installation.topology;
  const revision = positiveRevision(shardRevision);
  const nodes = [];
  for (let shard = 0; shard < shards; shard++) {
    for (let replica = 0; replica < replicas; replica++) {
      const index = shard * replicas + replica;
      const generation = revision > 1 ? `-g${revision}` : "";
      const logical = {
        id: `${manifest.metadata.name}${generation}-s${shard + 1}-r${replica + 1}`,
        shard: revision > 1 ? `shard-g${revision}-${shard}` : `shard-${shard}`,
        replica,
        index,
      };
      const materialized = materializeNode(logical, manifest);
      if (!materialized || typeof materialized !== "object") {
        throw new Error(`target driver did not materialize node ${logical.id}`);
      }
      const node = { ...logical, ...materialized };
      requireEndpoint(node.peerUrl, `${logical.id}.peerUrl`);
      requireEndpoint(node.publicUrl, `${logical.id}.publicUrl`);
      nodes.push(node);
    }
  }

  return {
    schemaVersion: 1,
    deployment: manifest.metadata.name,
    databaseVersion: manifest.installation.version,
    image: manifest.installation.artifact,
    driver: manifest.target.driver,
    shardRevision: revision,
    target: structuredClone(manifest.target),
    database: structuredClone(manifest.database),
    topology: { shards, replicas, nodes: nodes.length },
    runtime: structuredClone(manifest.installation.runtime),
    public: structuredClone(manifest.installation.public),
    nodes,
    shardMap: createShardMap(nodes),
  };
}

function positiveRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("shard revision must be a positive integer");
  return revision;
}

export function planSummary(plan) {
  return {
    deployment: plan.deployment,
    driver: plan.driver,
    artifact: plan.image,
    topology: plan.topology,
    nodes: plan.nodes.map(({ id, shard, replica, peerUrl, publicUrl }) => ({
      id,
      shard,
      replica: replica + 1,
      peerUrl,
      publicUrl,
    })),
  };
}

function createShardMap(nodes) {
  const shards = {};
  for (const node of nodes) {
    shards[node.shard] ||= { peers: [] };
    shards[node.shard].peers.push({ url: node.peerUrl });
  }
  return { version: 1, shards };
}

function requireEndpoint(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty URL`);
  try {
    new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
}
