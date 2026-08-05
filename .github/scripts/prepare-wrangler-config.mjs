import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  WORKER_NAME,
  CUSTOM_DOMAIN,
  KV_NAMESPACE_TITLE = 'edgetunnel',
  KV_BINDING_NAME = 'KV',
  WRANGLER_CONFIG_PATH = 'wrangler.toml',
  WRANGLER_DEPLOY_CONFIG_PATH = 'wrangler.deploy.toml',
} = process.env;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function escapeTomlString(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertTopLevelAssignment(config, eol, key, value) {
  const lines = config.split(/\r?\n/);
  const assignmentPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const kept = [];
  let replaced = false;

  for (const line of lines) {
    if (assignmentPattern.test(line)) {
      if (!replaced) {
        kept.push(`${key} = ${value}`);
        replaced = true;
      }
    } else {
      kept.push(line);
    }
  }

  if (!replaced) {
    const firstTableIndex = kept.findIndex((line) => /^\s*\[/.test(line));
    kept.splice(firstTableIndex === -1 ? kept.length : firstTableIndex, 0, `${key} = ${value}`);
  }

  return kept.join(eol);
}

function getTableName(line) {
  const match = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
  return match?.[1].trim() ?? null;
}

function removeTableBlocks(config, eol, shouldRemove) {
  const lines = config.split(/\r?\n/);
  const kept = [];

  for (let index = 0; index < lines.length;) {
    const tableName = getTableName(lines[index]);
    if (tableName && shouldRemove(tableName)) {
      index += 1;
      while (index < lines.length && !getTableName(lines[index])) {
        index += 1;
      }
      continue;
    }

    kept.push(lines[index]);
    index += 1;
  }

  return kept.join(eol);
}

function upsertKvNamespaceBinding(config, eol, bindingName, namespaceId) {
  const lines = config.split(/\r?\n/);
  const kept = [];
  const bindingPattern = new RegExp(
    `^\\s*binding\\s*=\\s*["']${escapeRegExp(bindingName)}["']\\s*(?:#.*)?$`,
    'm',
  );
  let replaced = false;

  for (let index = 0; index < lines.length;) {
    if (/^\s*\[\[\s*kv_namespaces\s*\]\]\s*$/.test(lines[index])) {
      const block = [lines[index]];
      index += 1;
      while (index < lines.length && !getTableName(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }

      if (bindingPattern.test(block.join(eol))) {
        if (!replaced) {
          while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
            kept.pop();
          }
          kept.push('[[kv_namespaces]]');
          kept.push(`binding = "${escapeTomlString(bindingName)}"`);
          kept.push(`id = "${escapeTomlString(namespaceId)}"`);
          kept.push('');
          replaced = true;
        }
      } else {
        kept.push(...block);
      }
      continue;
    }

    kept.push(lines[index]);
    index += 1;
  }

  if (!replaced) {
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
      kept.pop();
    }
    kept.push('');
    kept.push('[[kv_namespaces]]');
    kept.push(`binding = "${escapeTomlString(bindingName)}"`);
    kept.push(`id = "${escapeTomlString(namespaceId)}"`);
  }

  return kept.join(eol).replace(new RegExp(`(?:${escapeRegExp(eol)}){3,}`, 'g'), `${eol}${eol}`).trimEnd();
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
    const hint = response.status === 403
      ? ' 请确认 `CLOUDFLARE_API_TOKEN` 具有 `Workers KV Storage Write` 权限。'
      : '';
    fail(`Cloudflare API 请求失败：${details || `${response.status} ${response.statusText}`}.${hint}`);
  }

  return payload;
}

async function findNamespaceByTitle(title) {
  let page = 1;

  while (true) {
    const payload = await cloudflareRequest(
      `/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?page=${page}&per_page=100`,
    );
    const found = payload?.result?.find((item) => item.title === title);
    if (found) return found;

    const totalPages = payload?.result_info?.total_pages ?? 1;
    if (page >= totalPages || !payload?.result?.length) return null;
    page += 1;
  }
}

async function createNamespace(title) {
  const payload = await cloudflareRequest(
    `/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces`,
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    },
  );
  return payload.result;
}

async function ensureNamespace(title) {
  const existing = await findNamespaceByTitle(title);
  if (existing) {
    console.log(`Using existing KV namespace "${title}" (${existing.id}).`);
    return existing;
  }

  const created = await createNamespace(title);
  console.log(`Created KV namespace "${title}" (${created.id}).`);
  return created;
}

if (!WORKER_NAME?.trim()) fail('缺少环境变量 `WORKER_NAME`。');
if (!CUSTOM_DOMAIN?.trim()) fail('缺少环境变量 `CUSTOM_DOMAIN`。');
if (!CLOUDFLARE_API_TOKEN) fail('缺少环境变量 `CLOUDFLARE_API_TOKEN`。');
if (!CLOUDFLARE_ACCOUNT_ID) fail('缺少环境变量 `CLOUDFLARE_ACCOUNT_ID`。');

const sourcePath = resolve(WRANGLER_CONFIG_PATH);
const outputPath = resolve(WRANGLER_DEPLOY_CONFIG_PATH);
const sourceConfig = readFileSync(sourcePath, 'utf8');
const eol = sourceConfig.includes('\r\n') ? '\r\n' : '\n';

const namespace = await ensureNamespace(KV_NAMESPACE_TITLE);
let deployConfig = sourceConfig;
deployConfig = upsertTopLevelAssignment(
  deployConfig,
  eol,
  'name',
  `"${escapeTomlString(WORKER_NAME.trim())}"`,
);
deployConfig = upsertTopLevelAssignment(deployConfig, eol, 'main', '"app.js"');
deployConfig = upsertTopLevelAssignment(deployConfig, eol, 'workers_dev', 'false');
deployConfig = removeTableBlocks(
  deployConfig,
  eol,
  (tableName) => tableName === 'routes'
    || tableName === 'observability'
    || tableName.startsWith('observability.'),
);

const injectedBlocks = [
  '[[routes]]',
  `pattern = "${escapeTomlString(CUSTOM_DOMAIN.trim())}"`,
  'custom_domain = true',
  '',
  '[observability]',
  '[observability.logs]',
  'enabled = true',
  'invocation_logs = true',
  '',
  '[observability.traces]',
].join(eol);

deployConfig = `${deployConfig.trimEnd()}${eol}${eol}${injectedBlocks}`;
deployConfig = upsertKvNamespaceBinding(
  deployConfig,
  eol,
  KV_BINDING_NAME,
  namespace.id,
);
const serializedConfig = `${deployConfig}${eol}`;

writeFileSync(outputPath, serializedConfig, 'utf8');
console.log(`Prepared ${outputPath} with KV binding "${KV_BINDING_NAME}" -> "${KV_NAMESPACE_TITLE}".`);
