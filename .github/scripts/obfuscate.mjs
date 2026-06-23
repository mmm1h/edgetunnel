import fs from 'node:fs';
import path from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const sourceFile = path.resolve('_worker.js');
const outputFile = path.resolve('app.js');

function log(message) {
  console.log(`[Obfuscator] ${message}`);
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
  code = code.replaceAll("'https://edt-pages.github.io'", `_0xDec([${encryptedPages.join(',')}], '${xorKey}')`);
  
  // 'https://api.telegram.org/bot' -> _0xDec([1, 2, 3], 'key')
  code = code.replaceAll("'https://api.telegram.org/bot'", `_0xDec([${encryptedTg.join(',')}], '${xorKey}')`);
  
  // 'https://speed.cloudflare.com/locations' -> _0xDec([1, 2, 3], 'key')
  code = code.replaceAll("'https://speed.cloudflare.com/locations'", `_0xDec([${encryptedLocations.join(',')}], '${xorKey}')`);

  // 把解密辅助函数追加到头部
  code = xorDecryptHelper + '\n' + code;


  // 3. 无害化环境变量重映射
  log('正在进行无害化环境变量名称重映射...');
  code = code.replace(
    /const 管理员密码 = env\.ADMIN \|\| env\.admin \|\| env\.PASSWORD \|\| env\.password \|\| env\.pswd \|\| env\.TOKEN \|\| env\.KEY \|\| env\.UUID \|\| env\.uuid;/g,
    'const 管理员密码 = env.SITE_ACCESS_KEY;'
  );
  code = code.replace(
    /const envUUID = env\.UUID \|\| env\.uuid;/g,
    'const envUUID = env.SITE_ACCESS_KEY;'
  );
  code = code.replace(/env\.PROXYIP/g, 'env.STATIC_ASSETS_HOST');
  code = code.replace(/env\.GO2SOCKS5/g, 'env.REMOTE_GATEWAY_CONFIG');


  // 4. 动态路由前缀自动植入（基于 UUID 前 8 位）
  log('正在进行动态路由前缀重构...');
  // 注入获取 UUID 前缀的逻辑
  code = code.replace(
    /const 访问路径 = url\.pathname\.slice\(1\)\.toLowerCase\(\);/g,
    `const 访问路径 = url.pathname.slice(1).toLowerCase();\n\t\tconst _prefix = (userID && typeof userID === 'string') ? userID.split('-')[0].toLowerCase() + '-' : '';`
  );

  // 只对用户直接请求的登录入口、管理主页、退出和订阅前置路径添加前缀
  // 这样可以规避外部爬虫的主动探测扫描，同时确保网页内发起的子请求（如 admin/config.json）能被正常处理
  code = code.replace(/访问路径 === 'version'/g, `访问路径 === _prefix + 'version'`);
  code = code.replace(/访问路径 === 'login'/g, `访问路径 === _prefix + 'login'`);
  code = code.replace(/访问路径 === 'logout'/g, `访问路径 === _prefix + 'logout'`);
  code = code.replace(/访问路径 === 'sub'/g, `访问路径 === _prefix + 'sub'`);
  code = code.replace(/访问路径 === 'robots\.txt'/g, `访问路径 === _prefix + 'robots.txt'`);

  // 对于 admin 路由：访问路径 === 'admin' 或者是 admin/ 开头的子路由
  // 我们改造成：
  // 访问路径 === _prefix + 'admin' || (访问路径.startsWith('admin/') && (访问路径.slice(6) !== '' || 访问路径 === 'admin/'))
  // 注意，原来的判定是：访问路径 === 'admin' || 访问路径.startsWith('admin/')
  // 我们在替换时，为了确保 AJAX 请求 admin/config.json 能够被带 Cookie 匹配，而不需要改前缀，
  // 我们保持 admin/ 判定不变（因为后台自带了 auth 验证，未授权的人直接访问 /admin/config.json 也会被 Cookie 校验拦截返回 302 /login）
  code = code.replace(
    /访问路径 === 'admin' \|\| 访问路径\.startsWith\('admin\/'\)/g,
    `访问路径 === _prefix + 'admin' || 访问路径.startsWith('admin/')`
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
  code = code.replace(
    /async fetch\(request, env, ctx\) \{/g,
    `async fetch(request, env, ctx) {
\t\tif (Date.now() < 0) {
\t\t\t_dummyPolynomial(3.14);
\t\t\t_dummyMatrixMultiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]);
\t\t}`
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
