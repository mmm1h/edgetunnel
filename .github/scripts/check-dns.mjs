const {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
} = process.env;

async function cloudflareRequest(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return response.json();
}

async function main() {
  console.log('正在获取域名 zone_id...');
  const zonesRes = await cloudflareRequest('/zones?name=hmhi.top');
  const zone = zonesRes.result?.[0];
  if (!zone) {
    console.error('未找到 zone hmhi.top！');
    return;
  }
  console.log(`找到 zone: ${zone.name} (ID: ${zone.id})`);

  console.log('正在获取 z4w7e9.hmhi.top 的 DNS 记录...');
  const dnsRes = await cloudflareRequest(`/zones/${zone.id}/dns_records?name=z4w7e9.hmhi.top`);
  console.log('DNS 记录列表:\n', JSON.stringify(dnsRes.result, null, 2));

  console.log('正在获取 Workers 自定义域名绑定状态...');
  const domainsRes = await cloudflareRequest(`/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`);
  const match = domainsRes.result?.filter(d => d.hostname === 'z4w7e9.hmhi.top');
  console.log('Workers 自定义域名绑定详情:\n', JSON.stringify(match, null, 2));
}

main().catch(console.error);
