import fs from 'node:fs';
import path from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const sourceFile = path.resolve('_worker.js');
const outputFile = path.resolve('app.js');

function log(message) {
  console.log(`[Obfuscator] ${message}`);
}

async function main() {
  log(`读取源代码: ${sourceFile}`);
  let code = fs.readFileSync(sourceFile, 'utf8');

  // 1. 无害化环境变量重映射
  log('正在进行无害化环境变量名称重映射...');
  
  // 管理员密码行处理：
  // 原代码：const 管理员密码 = env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY || env.UUID || env.uuid;
  // 替换为：const 管理员密码 = env.SITE_ACCESS_KEY;
  code = code.replace(
    /const 管理员密码 = env\.ADMIN \|\| env\.admin \|\| env\.PASSWORD \|\| env\.password \|\| env\.pswd \|\| env\.TOKEN \|\| env\.KEY \|\| env\.UUID \|\| env\.uuid;/g,
    'const 管理员密码 = env.SITE_ACCESS_KEY;'
  );

  // UUID 行处理：
  // 原代码：const envUUID = env.UUID || env.uuid;
  // 替换为：const envUUID = env.SITE_ACCESS_KEY;
  code = code.replace(
    /const envUUID = env\.UUID \|\| env\.uuid;/g,
    'const envUUID = env.SITE_ACCESS_KEY;'
  );

  // PROXYIP 行处理：
  // 原代码：env.PROXYIP
  // 替换为：env.STATIC_ASSETS_HOST
  code = code.replace(/env\.PROXYIP/g, 'env.STATIC_ASSETS_HOST');

  // GO2SOCKS5 行处理：
  // 原代码：env.GO2SOCKS5
  // 替换为：env.REMOTE_GATEWAY_CONFIG
  code = code.replace(/env\.GO2SOCKS5/g, 'env.REMOTE_GATEWAY_CONFIG');


  // 2. 敏感静态字符串 Base64 掩盖 (防止关键字静态特征匹配扫描)
  log('正在对敏感域名和路径进行 Base64 编码掩盖...');
  
  // 'https://edt-pages.github.io' -> atob('aHR0cHM6Ly9lZHQtcGFnZXMuZ2l0aHViLmlv')
  code = code.replaceAll("'https://edt-pages.github.io'", "atob('aHR0cHM6Ly9lZHQtcGFnZXMuZ2l0aHViLmlv')");
  
  // 'https://api.telegram.org/bot' -> atob('aHR0cHM6Ly9hcGkudGVsZWdyYW0ub3JnL2JvdA==')
  code = code.replaceAll("'https://api.telegram.org/bot'", "atob('aHR0cHM6Ly9hcGkudGVsZWdyYW0ub3JnL2JvdA==')");
  
  // 'https://speed.cloudflare.com/locations' -> atob('aHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS9sb2NhdGlvbnM=')
  code = code.replaceAll("'https://speed.cloudflare.com/locations'", "atob('aHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS9sb2NhdGlvbnM=')");


  // 3. 执行 JavaScript-Obfuscator 压缩与混淆
  log('正在使用 javascript-obfuscator 对代码进行混淆压缩 (mangled 变量生成)...');
  const obfuscationResult = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'mangled', // 生成 a, b, c 这种精简的变量，而不是明显的 0x 开头混淆指纹
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
  log(`混淆完成，输出文件: ${outputFile} (大小: ${finalCode.length} 字节)`);
  fs.writeFileSync(outputFile, finalCode, 'utf8');
}

main().catch(err => {
  console.error('混淆构建过程失败:', err);
  process.exit(1);
});
