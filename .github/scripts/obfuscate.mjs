import fs from 'node:fs';
import path from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const sourceFile = path.resolve('_worker.js');
const outputFile = path.resolve('app.js');

function log(message) {
  console.log(`[Obfuscator] ${message}`);
}

function replaceChecked(label, source, pattern, replacement, { min, max }) {
  let matches = 0;
  const replaceMatch = (...args) => {
    matches++;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  };
  const result = typeof pattern === 'string'
    ? source.replaceAll(pattern, replaceMatch)
    : source.replace(pattern, replaceMatch);

  log(`替换校验 [${label}]: 命中 ${matches} 次，期望 ${min}-${max} 次`);
  if (matches < min || matches > max) {
    console.error(`[Obfuscator] 替换校验失败 [${label}]: 命中 ${matches} 次，期望 ${min}-${max} 次`);
    process.exit(1);
  }

  return result;
}

// 随机密钥生成器
function generateRandomKey(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < length; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// XOR 加密函数
function xorEncrypt(text, key) {
  const encrypted = [];
  for (let i = 0; i < text.length; i++) {
    encrypted.push(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return encrypted;
}

async function main() {
  log(`读取源代码: ${sourceFile}`);
  let code = fs.readFileSync(sourceFile, 'utf8');

  // 1. 动态生成 XOR 解密辅助代码并注入到文件的全局常量和工具函数区
  log('正在生成动态 XOR 解密器...');
  const xorKey = generateRandomKey(12);
  
  // 注入 XOR 解密函数
  const xorDecryptHelper = `
function _0xDec(arr, key) {
  let str = '';
  for (let i = 0; i < arr.length; i++) {
    str += String.fromCharCode(arr[i] ^ key.charCodeAt(i % key.length));
  }
  return str;
}
`;

  // 2. 敏感静态字符串 XOR 加密替换
  log('正在进行敏感字符串 XOR 编译期加密...');
  
  const sensitiveStrings = {
    Pages静态页面: 'https://edt-pages.github.io',
    TG_API: 'https://api.telegram.org/bot',
    CF_Speed_Locations: 'https://speed.cloudflare.com/locations'
  };

  // 替换代码中的硬编码字符串
  const encryptedPages = xorEncrypt(sensitiveStrings.Pages静态页面, xorKey);
  const encryptedTg = xorEncrypt(sensitiveStrings.TG_API, xorKey);
  const encryptedLocations = xorEncrypt(sensitiveStrings.CF_Speed_Locations, xorKey);

  // 'https://edt-pages.github.io' -> _0xDec([1, 2, 3], 'key')
  code = replaceChecked(
    'xor.pages-static',
    code,
    "'https://edt-pages.github.io'",
    `_0xDec([${encryptedPages.join(',')}], '${xorKey}')`,
    { min: 1, max: 1 }
  );
  
  // `https://api.telegram.org/bot${token}...` -> `${_0xDec([...], 'key')}${token}...`
  code = replaceChecked(
    'xor.telegram-api-template-prefix',
    code,
    '`https://api.telegram.org/bot',
    `\`\${_0xDec([${encryptedTg.join(',')}], '${xorKey}')}`,
    { min: 1, max: 1 }
  );
  
  // 'https://speed.cloudflare.com/locations' -> _0xDec([1, 2, 3], 'key')
  code = replaceChecked(
    'xor.cf-speed-locations',
    code,
    "'https://speed.cloudflare.com/locations'",
    `_0xDec([${encryptedLocations.join(',')}], '${xorKey}')`,
    { min: 1, max: 1 }
  );

  // 把解密辅助函数追加到头部
  code = xorDecryptHelper + '\n' + code;


  // 3. 无害化环境变量重映射
  log('正在进行无害化环境变量名称重映射...');
  code = replaceChecked(
    'env.admin-password',
    code,
    /const 管理员密码 = env\.ADMIN \|\| env\.admin \|\| env\.PASSWORD \|\| env\.password \|\| env\.pswd \|\| env\.TOKEN \|\| env\.KEY \|\| env\.UUID \|\| env\.uuid;/g,
    'const 管理员密码 = env.ADMIN_PASS || env.SITE_ACCESS_KEY;',
    { min: 1, max: 1 }
  );
  code = replaceChecked(
    'env.uuid',
    code,
    /const envUUID = env\.UUID \|\| env\.uuid;/g,
    'const envUUID = env.SITE_ACCESS_KEY;',
    { min: 1, max: 1 }
  );
  code = replaceChecked(
    'env.proxyip',
    code,
    /env\.PROXYIP/g,
    'env.STATIC_ASSETS_HOST',
    { min: 2, max: 2 }
  );
  code = replaceChecked(
    'env.go2socks5',
    code,
    /env\.GO2SOCKS5/g,
    'env.REMOTE_GATEWAY_CONFIG',
    { min: 2, max: 2 }
  );


  // 4. 动态路由前缀自动置入与剥离，以及 HTML/重定向路径动态重写
  log('正在进行动态路由前缀重构与剥离...');
  const prefixStripper = `const 原始访问路径 = url.pathname.slice(1).toLowerCase();
		const _prefix = (userID && typeof userID === 'string') ? userID.split('-')[0].toLowerCase() + '-' : '';
		let 访问路径 = 原始访问路径;
		if (_prefix && 原始访问路径.startsWith(_prefix)) {
			访问路径 = 原始访问路径.slice(_prefix.length);
		} else if (原始访问路径 === 'admin' || 原始访问路径.startsWith('admin/') || 原始访问路径 === 'login' || 原始访问路径 === 'logout' || 原始访问路径 === 'sub' || 原始访问路径 === 'version' || 原始访问路径 === 'robots.txt') {
			return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
		}`;

  code = replaceChecked(
    'route.access-path',
    code,
    /const 访问路径 = url\.pathname\.slice\(1\)\.toLowerCase\(\);/g,
    prefixStripper,
    { min: 1, max: 1 }
  );

  // 拦截并重写返回给浏览器的后台 HTML，将其中硬编码的 /admin/ 接口调用动态加上 UUID 前缀以绕过 WAF
  const adminHtmlRewriter = `const res = await fetch(Pages静态页面 + '/admin' + url.search);
					let html = await res.text();
					html = html.replaceAll('/admin/', '/' + _prefix + 'admin/');
					html = html.replaceAll('/sub?', '/' + _prefix + 'sub?');
					html = html.replaceAll("href = '/logout'", "href = '/" + _prefix + "logout'");
					html = html.replaceAll('/version?', '/' + _prefix + 'version?');
					return new Response(html, {
						status: res.status,
						headers: {
							...Object.fromEntries(res.headers),
							'Content-Type': 'text/html; charset=UTF-8',
							'Cache-Control': 'no-store'
						}
					});`;

  code = replaceChecked(
    'route.admin-html',
    code,
    /return fetch\(Pages静态页面 \+ '\/admin' \+ url\.search\);/g,
    adminHtmlRewriter,
    { min: 1, max: 1 }
  );

  // 拦截并重写返回给浏览器的登录 HTML，将其中提交表单的 /login 接口及跳转的 /admin 地址动态加上 UUID 前缀
  const loginHtmlRewriter = `const res = await fetch(Pages静态页面 + '/login');
					let html = await res.text();
					html = html.replace("fetch('/login'", "fetch('/" + _prefix + "login'");
					html = html.replace("window.location.href = '/admin'", "window.location.href = '/" + _prefix + "admin'");
					return new Response(html, {
						status: res.status,
						headers: res.headers
					});`;

  code = replaceChecked(
    'route.login-html',
    code,
    /return fetch\(Pages静态页面 \+ '\/login'\);/g,
    loginHtmlRewriter,
    { min: 1, max: 1 }
  );

  // 动态修改重定向地址，在重定向到 admin 或 login 时自动添加前缀
  code = replaceChecked(
    'redirect.admin',
    code,
    /'Location': '\/admin'/g,
    `'Location': '/' + _prefix + 'admin'`,
    { min: 1, max: 1 }
  );
  code = replaceChecked(
    'redirect.login',
    code,
    /'Location': '\/login'/g,
    `'Location': '/' + _prefix + 'login'`,
    { min: 2, max: 2 }
  );

  // 区分大小写访问路径剥离前缀，确保后台 API 正常工作
  code = replaceChecked(
    'route.case-sensitive-path',
    code,
    /const 区分大小写访问路径 = url\.pathname\.slice\(1\);/g,
    `let 区分大小写访问路径 = url.pathname.slice(1);
				if (_prefix && 区分大小写访问路径.startsWith(_prefix)) {
					区分大小写访问路径 = 区分大小写访问路径.slice(_prefix.length);
				}`,
    { min: 1, max: 1 }
  );

  // 动态修改 /sub 相关的重定向与内部请求链接，自动注入 UUID 前缀
  code = replaceChecked(
    'redirect.sub-params',
    code,
    /'Location': `\/sub\?\${params\.toString\(\)}`/g,
    `'Location': '/' + _prefix + 'sub?' + params.toString()`,
    { min: 1, max: 1 }
  );
  code = replaceChecked(
    'route.mixed-sub-token',
    code,
    /'\/sub\?target=mixed&token='/g,
    `'/' + _prefix + 'sub?target=mixed&token='`,
    { min: 1, max: 1 }
  );
  code = replaceChecked(
    'route.sub-token',
    code,
    /'\/sub\?token='/g,
    `'/' + _prefix + 'sub?token='`,
    { min: 1, max: 1 }
  );
  code = replaceChecked(
    'header.profile-web-page-url',
    code,
    /"Profile-web-page-url": url\.protocol \+ '\/\/' \+ url\.host \+ '\/admin',/g,
    `"Profile-web-page-url": url.protocol + '//' + url.host + '/' + _prefix + 'admin',`,
    { min: 1, max: 1 }
  );


  // 5. 注入第三方无害数学库死代码（打碎 AST 指纹相似度比对）
  log('正在注入无害数学库噪声代码 (破坏 AST 相似度哈希)...');
  const dummyMathLibrary = `
function _dummyPolynomial(x) {
  let coef = [1.2, -3.4, 5.6, -7.8, 9.0];
  let res = 0;
  for (let i = 0; i < coef.length; i++) {
    res += coef[i] * Math.pow(x, i);
  }
  return Math.sin(res) * Math.cos(x);
}
function _dummyMatrixMultiply(m1, m2) {
  let result = [];
  for (let i = 0; i < 2; i++) {
    result[i] = [];
    for (let j = 0; j < 2; j++) {
      let sum = 0;
      for (let k = 0; k < 2; k++) {
        sum += m1[i][k] * m2[k][j];
      }
      result[i][j] = sum;
    }
  }
  return result;
}
`;

  // 在头部添加噪音代码并在入口处假引用，防止被编译器剪枝优化掉
  code = dummyMathLibrary + '\n' + code;
  
  // 在入口方法 fetch 内部开头注入虚假判定引用
  code = replaceChecked(
    'entry.fetch',
    code,
    /async fetch\(request, env, ctx\) \{/g,
    `async fetch(request, env, ctx) {
\t\tif (Date.now() < 0) {
\t\t\t_dummyPolynomial(3.14);
\t\t\t_dummyMatrixMultiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]);
\t\t}`,
    { min: 1, max: 1 }
  );


  // 6. 执行 javascript-obfuscator 混淆
  log('正在运行 javascript-obfuscator...');
  const obfuscationResult = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'mangled',
    log: false,
    numbersToExpressions: false,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: false,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    target: 'browser-no-eval',
    transformObjectKeys: true,
    unicodeEscapeSequence: false
  });

  const finalCode = obfuscationResult.getObfuscatedCode();
  log(`混淆打包完成，输出文件: ${outputFile} (大小: ${finalCode.length} 字节)`);
  fs.writeFileSync(outputFile, finalCode, 'utf8');
}

main().catch(err => {
  console.error('构建过程异常失败:', err);
  process.exit(1);
});
