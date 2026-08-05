import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
} = process.env;

const DEFAULT_TARGET_HOSTNAMES = ['edge.hmhi.top', 'z4w7e9.hmhi.top'];
const DEFAULT_WORKERS_TO_DELETE = ['edgetunnel'];

class CloudflareApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
  }
}

function fail(message) {
  throw new Error(message);
}

function parseTomlString(value, key) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) {
    fail(`wrangler 配置中的 ${key} 必须是带引号的字符串。`);
  }

  if (quote === "'") return trimmed.slice(1, -1);

  try {
    return JSON.parse(trimmed);
  } catch {
    fail(`wrangler 配置中的 ${key} 不是有效字符串。`);
  }
}

export function parseDeploymentConfig(config) {
  let section = '';
  let workerName = '';
  let currentRoute = null;
  const routes = [];

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const arraySectionMatch = line.match(/^\[\[\s*([^\]]+)\s*\]\]$/);
    if (arraySectionMatch) {
      section = arraySectionMatch[1].trim();
      currentRoute = section === 'routes' ? {} : null;
      if (currentRoute) routes.push(currentRoute);
      continue;
    }

    const sectionMatch = line.match(/^\[\s*([^\]]+)\s*\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      currentRoute = null;
      continue;
    }

    const assignmentMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!assignmentMatch) continue;

    const [, key, value] = assignmentMatch;
    if (!section && key === 'name') {
      workerName = parseTomlString(value, 'name');
    } else if (currentRoute && key === 'pattern') {
      currentRoute.pattern = parseTomlString(value, 'routes.pattern');
    } else if (currentRoute && key === 'custom_domain') {
      currentRoute.customDomain = value === 'true';
    }
  }

  if (!workerName) fail('无法从 wrangler 配置解析当前 Worker 名称，已中止 cleanup。');

  const customDomainHostnames = [...new Set(routes
    .filter((route) => route.customDomain && route.pattern)
    .map((route) => route.pattern.trim().toLowerCase()))];

  if (customDomainHostnames.length === 0) {
    fail('无法从 wrangler 配置解析当前自定义域名，已中止 cleanup。');
  }

  return { workerName, customDomainHostnames };
}

export function readCurrentDeploymentConfig(configPaths = [
  'wrangler.deploy.toml',
  'wrangler.toml',
]) {
  const configPath = configPaths.map((item) => resolve(item)).find(existsSync);
  if (!configPath) fail('找不到 wrangler.deploy.toml 或 wrangler.toml，已中止 cleanup。');

  const parsed = parseDeploymentConfig(readFileSync(configPath, 'utf8'));
  return { ...parsed, configPath };
}

export function buildCleanupTargets({
  domains,
  currentWorkerName,
  currentHostnames,
  targetHostnames = DEFAULT_TARGET_HOSTNAMES,
  workersToDelete = DEFAULT_WORKERS_TO_DELETE,
}) {
  const protectedWorker = currentWorkerName.toLowerCase();
  const protectedHostnames = new Set(currentHostnames.map((item) => item.toLowerCase()));
  const requestedHostnames = new Set(targetHostnames.map((item) => item.toLowerCase()));

  const oldDomains = domains.filter((domain) => {
    const hostname = domain.hostname?.toLowerCase();
    const service = domain.service?.toLowerCase();

    if (!hostname || protectedHostnames.has(hostname) || service === protectedWorker) return false;
    return service === 'edgetunnel' || requestedHostnames.has(hostname);
  });

  const oldWorkers = workersToDelete.filter(
    (worker) => worker.toLowerCase() !== protectedWorker,
  );

  return { oldDomains, oldWorkers };
}

async function cloudflareRequest(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.success === false) {
    const details = payload?.errors?.map((item) => item.message).filter(Boolean).join('; ');
    throw new CloudflareApiError(
      details || `${response.status} ${response.statusText}`,
      response.status,
    );
  }

  return payload;
}

async function main() {
  const current = readCurrentDeploymentConfig();
  console.log(`当前部署配置: ${current.configPath}`);
  console.log(`受保护的 Worker: ${current.workerName}`);
  console.log(`受保护的自定义域名: ${current.customDomainHostnames.join(', ') || '(无)'}`);

  if (!CLOUDFLARE_API_TOKEN) fail('缺少环境变量 `CLOUDFLARE_API_TOKEN`。');
  if (!CLOUDFLARE_ACCOUNT_ID) fail('缺少环境变量 `CLOUDFLARE_ACCOUNT_ID`。');

  const failures = [];
  let domains = [];

  console.log('正在查找旧 Worker 关联的自定义域名...');
  try {
    const payload = await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`);
    domains = payload.result || [];
  } catch (err) {
    failures.push(`获取自定义域名列表失败: ${err.message}`);
  }

  const { oldDomains, oldWorkers } = buildCleanupTargets({
    domains,
    currentWorkerName: current.workerName,
    currentHostnames: current.customDomainHostnames,
  });

  for (const domain of oldDomains) {
    console.log(`正在删除自定义域名映射: ${domain.hostname} (ID: ${domain.id})...`);
    try {
      await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${domain.id}`, {
        method: 'DELETE',
      });
      console.log(`已成功删除 ${domain.hostname} 的映射。`);
    } catch (err) {
      if (err.status === 404) {
        console.log(`自定义域名映射 ${domain.hostname} 已不存在。`);
      } else {
        failures.push(`删除自定义域名映射 ${domain.hostname} 失败: ${err.message}`);
      }
    }
  }

  for (const worker of oldWorkers) {
    console.log(`正在删除旧的 Worker 脚本 (${worker})...`);
    try {
      await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}`, {
        method: 'DELETE',
      });
      console.log(`已成功删除旧的 Worker (${worker})。`);
    } catch (err) {
      if (err.status === 404) {
        console.log(`旧 Worker ${worker} 已不存在。`);
      } else {
        failures.push(`删除旧 Worker ${worker} 失败: ${err.message}`);
      }
    }
  }

  if (failures.length > 0) fail(failures.join('\n'));
}

const isMainModule = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
