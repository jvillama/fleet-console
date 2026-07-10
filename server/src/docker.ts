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

export async function getFleetOverview(): Promise<FleetOverview> {
  const [containers, version, info] = await Promise.all([
    docker.listContainers({ all: true }),
    docker.version(),
    docker.info(),
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
 * close() destroys the daemon connection so it stops following.
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
