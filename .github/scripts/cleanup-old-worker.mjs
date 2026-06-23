import { readFileSync } from 'node:fs';

const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
} = process.env;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
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
    throw new Error(details || `${response.status} ${response.statusText}`);
  }

  return payload;
}

async function main() {
  if (!CLOUDFLARE_API_TOKEN) fail('缺少环境变量 `CLOUDFLARE_API_TOKEN`。');
  if (!CLOUDFLARE_ACCOUNT_ID) fail('缺少环境变量 `CLOUDFLARE_ACCOUNT_ID`。');

  console.log('正在查找与 edgetunnel 或 homepage 关联的自定义域名...');
  let domains = [];
  try {
    const domainsPayload = await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`);
    domains = domainsPayload.result || [];
  } catch (err) {
    console.log('获取自定义域名列表失败：', err.message);
  }
  
  // 查找指向 "edgetunnel" 服务的自定义域名，或者特定域名
  const targetHostnames = ['edge.hmhi.top', 'z4w7e9.hmhi.top'];
  const oldDomains = domains.filter(d => 
    d.service === 'edgetunnel' || 
    targetHostnames.includes(d.hostname)
  );
  
  for (const domain of oldDomains) {
    console.log(`正在删除自定义域名映射: ${domain.hostname} (ID: ${domain.id})...`);
    try {
      await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${domain.id}`, {
        method: 'DELETE'
      });
      console.log(`已成功删除 ${domain.hostname} 的映射。`);
    } catch (err) {
      console.log(`删除自定义域名映射 ${domain.hostname} 失败：`, err.message);
    }
  }

  // 需要删除的旧 Worker 脚本列表
  const workersToDelete = ['edgetunnel'];
  for (const worker of workersToDelete) {
    console.log(`正在删除旧的 Worker 脚本 (${worker})...`);
    try {
      await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}`, {
        method: 'DELETE'
      });
      console.log(`已成功删除旧的 Worker (${worker})。`);
    } catch (err) {
      console.log(`未找到 ${worker} 脚本或已被删除：`, err.message);
    }
  }
}

main().catch(err => {
  console.error('执行过程中发生未捕获错误:', err);
  process.exit(1);
});
