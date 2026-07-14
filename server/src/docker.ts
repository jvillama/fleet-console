import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type {
  ContainerState,
  ContainerStats,
  ContainerSummary,
  FleetOverview,
  PortMapping,
} from "./types.js";

/**
 * Thin, typed wrapper around the Docker Engine API.
 *
 * All dockerode access lives here so route handlers stay clean and the
 * Docker dependency can be mocked in tests. Connects to the local Docker
 * socket by default; set DOCKER_SOCKET to override.
 */

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
});

function toState(raw: string): ContainerState {
  const known: ContainerState[] = [
    "running",
    "exited",
    "paused",
    "restarting",
    "created",
    "dead",
    "removing",
  ];
  return (known as string[]).includes(raw) ? (raw as ContainerState) : "dead";
}

function toPorts(ports: Docker.Port[]): PortMapping[] {
  return ports
    .filter((p) => p.PrivatePort !== undefined)
    .map((p) => {
      const mapping: PortMapping = {
        containerPort: p.PrivatePort,
        protocol: p.Type === "udp" ? "udp" : "tcp",
      };
      if (p.PublicPort !== undefined) mapping.hostPort = p.PublicPort;
      return mapping;
    });
}

export async function listContainers(): Promise<ContainerSummary[]> {
  // all: true so stopped containers show up — an ops console that hides
  // dead machines is not much of an ops console.
  const containers = await docker.listContainers({ all: true });

  return containers.map((c) => ({
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name: (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
    image: c.Image,
    state: toState(c.State),
    status: c.Status,
    createdAt: new Date(c.Created * 1000).toISOString(),
    ports: toPorts(c.Ports),
  }));
}

export async function getContainerStats(id: string): Promise<ContainerStats> {
  const container = docker.getContainer(id);
  // stream: false returns a single sample that includes the previous
  // sample (precpu_stats), which is what the CPU delta calculation needs.
  const stats = await container.stats({ stream: false });

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage ?? 0);
  const onlineCpus =
    stats.cpu_stats.online_cpus ??
    stats.cpu_stats.cpu_usage.percpu_usage?.length ??
    1;

  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * onlineCpus * 100
      : 0;

  const memoryUsageBytes = stats.memory_stats.usage ?? 0;
  const memoryLimitBytes = stats.memory_stats.limit ?? 0;

  return {
    id,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent:
      memoryLimitBytes > 0
        ? Math.round((memoryUsageBytes / memoryLimitBytes) * 1000) / 10
        : 0,
    sampledAt: new Date().toISOString(),
  };
}

/** @types/dockerode declares `info(): Promise<any>` — narrow it once at the boundary. */
interface DockerSystemInfo {
  Name?: string;
}

export async function getFleetOverview(): Promise<FleetOverview> {
  const [containers, version, info] = await Promise.all([
    docker.listContainers({ all: true }),
    docker.version(),
    docker.info() as Promise<DockerSystemInfo>,
  ]);

  const running = containers.filter((c) => c.State === "running").length;

  return {
    total: containers.length,
    running,
    stopped: containers.length - running,
    dockerVersion: version.Version,
    hostName: info.Name ?? "unknown",
  };
}

export interface ActionOutcome {
  /** Container state after the action, from a fresh inspect. */
  state: ContainerState;
  /** True when Docker answered 304 — it was already in the desired state. */
  noOp: boolean;
}

/**
 * Shared body for the three mutating actions. Docker answers HTTP 304
 * ("not modified") when the container is already in the desired state —
 * the desired state holds, so that is success, flagged as a no-op for the
 * audit detail. Any other error propagates to the route's error mapping.
 */
async function runAction(
  id: string,
  act: (container: Docker.Container) => Promise<unknown>,
): Promise<ActionOutcome> {
  const container = docker.getContainer(id);
  let noOp = false;
  try {
    await act(container);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 304) noOp = true;
    else throw err;
  }
  const info = await container.inspect();
  return { state: toState(info.State.Status), noOp };
}

export function startContainer(id: string): Promise<ActionOutcome> {
  return runAction(id, (c) => c.start());
}

export function stopContainer(id: string): Promise<ActionOutcome> {
  // Docker's default 10s SIGTERM grace period — no timeout knob this slice.
  return runAction(id, (c) => c.stop());
}

export function restartContainer(id: string): Promise<ActionOutcome> {
  return runAction(id, (c) => c.restart());
}

/** Used by /api/health to report whether the Docker socket is reachable. */
export async function pingDocker(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export interface LogStream {
  stream: NodeJS.ReadableStream;
  close: () => void;
}

/**
 * Live log stream for one container: last `tail` lines, then follow.
 * TTY containers emit plain text; non-TTY containers use Docker's
 * multiplexed framing, which is demuxed here so callers always get text.
 * close() destroys the daemon connection so it stops following (and, for
 * non-TTY containers, the demuxed stream so consumers see the teardown).
 */
export async function streamContainerLogs(
  id: string,
  opts: { tail: number },
): Promise<LogStream> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const source = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: opts.tail,
  });

  const close = (): void => {
    (source as unknown as { destroy?: () => void }).destroy?.();
  };

  if (info.Config.Tty) {
    return { stream: source, close };
  }

  const demuxed = new PassThrough();
  docker.modem.demuxStream(source, demuxed, demuxed);
  source.on("end", () => demuxed.end());
  source.on("error", (err) => demuxed.destroy(err as Error));
  return {
    stream: demuxed,
    close: () => {
      close();
      demuxed.destroy();
    },
  };
}

// --- Phase 3: deployment workflow ---------------------------------------

/** Pull repo:tag through the daemon; resolves when the pull completes. */
export async function pullImage(ref: string): Promise<void> {
  const stream = await docker.pull(ref);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) =>
      err ? reject(err) : resolve(),
    );
  });
}

export interface RecreateSpec {
  id: string;
  /** Container name without the leading slash — stable across recreates. */
  name: string;
  /** Full image ref currently in use. */
  image: string;
  wasRunning: boolean;
  /** Create options carried over from the old container (sans name/Image). */
  createOptions: Docker.ContainerCreateOptions;
  /** Networks beyond HostConfig.NetworkMode, connected after create. */
  extraNetworks: { name: string; aliases: string[] }[];
}

/** Everything needed to recreate a container with a different image. */
export async function inspectForRecreate(idOrName: string): Promise<RecreateSpec> {
  const info = await docker.getContainer(idOrName).inspect();
  const name = info.Name.replace(/^\//, "");
  const networkMode = info.HostConfig.NetworkMode ?? "default";
  const networks = info.NetworkSettings?.Networks ?? {};
  // @types/dockerode declares NetworkInfo.Aliases as `any` — narrow to
  // string[] once here rather than propagating `any` through every use.
  const extraNetworks = Object.entries(networks)
    .filter(([netName]) => netName !== networkMode)
    .map(([netName, cfg]) => ({
      name: netName,
      // Docker adds a short-id alias of its own; a recreated container gets
      // a fresh one, so carrying the old id over would be wrong.
      aliases: ((cfg.Aliases ?? []) as string[]).filter((a) => !info.Id.startsWith(a)),
    }));
  const primaryAliases = ((networks[networkMode]?.Aliases ?? []) as string[]).filter(
    (a) => !info.Id.startsWith(a),
  );

  return {
    id: info.Id,
    name,
    image: info.Config.Image,
    wasRunning: info.State.Running,
    createOptions: {
      Env: info.Config.Env,
      Cmd: info.Config.Cmd,
      Entrypoint: info.Config.Entrypoint,
      Labels: info.Config.Labels,
      ExposedPorts: info.Config.ExposedPorts,
      Healthcheck: info.Config.Healthcheck,
      WorkingDir: info.Config.WorkingDir || undefined,
      User: info.Config.User || undefined,
      HostConfig: info.HostConfig,
      // Docker re-joins the NetworkMode network implicitly but WITHOUT the
      // old endpoint's aliases — a compose service's service-name alias
      // would be lost, breaking peer DNS. Carry it explicitly.
      ...(primaryAliases.length > 0
        ? {
            NetworkingConfig: {
              EndpointsConfig: { [networkMode]: { Aliases: primaryAliases } },
            },
          }
        : {}),
    },
    extraNetworks,
  };
}

/** Where recreateContainer parks the replaced container. deploy.ts uses
 * this to name leftovers in deployment details and to clean them up on
 * rollback — keep the two sides of the contract in one place. */
export function parkedContainerName(name: string, deploymentId: number): string {
  return `${name}-predeploy-${deploymentId}`;
}

/**
 * Replace a container with a copy running newImage: stop → rename (frees
 * the name) → create + start the replacement. If anything fails after the
 * rename, the original is renamed back (and restarted if it was running)
 * before the error propagates, so the fleet looks untouched. Returns the
 * new container's id.
 */
export async function recreateContainer(
  spec: RecreateSpec,
  newImage: string,
  deploymentId: number,
): Promise<string> {
  const old = docker.getContainer(spec.id);
  const parkedName = parkedContainerName(spec.name, deploymentId);

  if (spec.wasRunning) {
    try {
      await old.stop();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  await old.rename({ name: parkedName });

  let createdId: string | null = null;
  try {
    const created = await docker.createContainer({
      ...spec.createOptions,
      name: spec.name,
      Image: newImage,
    });
    createdId = created.id;
    for (const net of spec.extraNetworks) {
      await docker.getNetwork(net.name).connect({
        Container: created.id,
        EndpointConfig: net.aliases.length > 0 ? { Aliases: net.aliases } : {},
      });
    }
    await created.start();
    return created.id;
  } catch (err) {
    // Best-effort restore; the original error is the one worth surfacing.
    try {
      if (createdId !== null) {
        await docker.getContainer(createdId).remove({ force: true });
      }
      await old.rename({ name: spec.name });
      if (spec.wasRunning) await old.start();
    } catch {
      // Restore failed too — the original is still parked under parkedName;
      // the deployment's detail carries the primary error for the operator.
    }
    throw err;
  }
}

export async function removeContainer(id: string): Promise<void> {
  await docker.getContainer(id).remove();
}

export interface HealthOutcome {
  healthy: boolean;
  reason?: string;
}

const HEALTH_POLL_MS = 1000;
const HEALTH_DEADLINE_MS = 60_000;
const NO_HEALTHCHECK_GRACE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watch a freshly started container come up. With a HEALTHCHECK: poll until
 * Docker reports healthy (ok) or unhealthy / 60 s deadline (failed). Without
 * one: the container must still be running after a 10 s grace period.
 */
export async function watchHealth(id: string): Promise<HealthOutcome> {
  const container = docker.getContainer(id);
  const first = await container.inspect();

  if (first.State.Health === undefined) {
    await sleep(NO_HEALTHCHECK_GRACE_MS);
    const after = await container.inspect();
    return after.State.Running
      ? { healthy: true }
      : {
          healthy: false,
          reason: `container ${after.State.Status} during 10s grace period`,
        };
  }

  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  let status: string = first.State.Health.Status;
  while (Date.now() < deadline) {
    if (status === "healthy") return { healthy: true };
    if (status === "unhealthy") {
      return { healthy: false, reason: "container reported unhealthy" };
    }
    await sleep(HEALTH_POLL_MS);
    status = (await container.inspect()).State.Health?.Status ?? "starting";
  }
  return { healthy: false, reason: "health check deadline (60s) exceeded" };
}

/** True when the daemon already has this image ref locally. */
export async function imageExistsLocally(ref: string): Promise<boolean> {
  try {
    await docker.getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}
