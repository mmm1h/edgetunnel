import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
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

function upsertKvNamespaceBinding(config, eol, bindingName, namespaceId) {
  const lines = config.split(/\r?\n/);
  const kept = [];
  const bindingPattern = new RegExp(
    `^\\s*binding\\s*=\\s*["']${escapeRegExp(bindingName)}["']\\s*$`,
    'm',
  );
  let replaced = false;

  for (let index = 0; index < lines.length;) {
    if (/^\s*\[\[\s*kv_namespaces\s*\]\]\s*$/.test(lines[index])) {
      const block = [lines[index]];
      index += 1;
      while (index < lines.length && !/^\s*(\[\[.*\]\]|\[.*\])\s*$/.test(lines[index])) {
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

if (!CLOUDFLARE_API_TOKEN) fail('缺少环境变量 `CLOUDFLARE_API_TOKEN`。');
if (!CLOUDFLARE_ACCOUNT_ID) fail('缺少环境变量 `CLOUDFLARE_ACCOUNT_ID`。');

const sourcePath = resolve(WRANGLER_CONFIG_PATH);
const outputPath = resolve(WRANGLER_DEPLOY_CONFIG_PATH);
const sourceConfig = readFileSync(sourcePath, 'utf8');
const eol = sourceConfig.includes('\r\n') ? '\r\n' : '\n';

const namespace = await ensureNamespace(KV_NAMESPACE_TITLE);
const deployConfig = `${upsertKvNamespaceBinding(
  sourceConfig,
  eol,
  KV_BINDING_NAME,
  namespace.id,
)}${eol}`;

writeFileSync(outputPath, deployConfig, 'utf8');
console.log(`Prepared ${outputPath} with KV binding "${KV_BINDING_NAME}" -> "${KV_NAMESPACE_TITLE}".`);
