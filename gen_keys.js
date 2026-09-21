// 生成 Ed25519 密钥对：私钥留服务器，公钥(SPKI base64)给客户端做本地验签
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'keys');
fs.mkdirSync(dir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const pubSpkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

fs.writeFileSync(path.join(dir, 'private.pem'), privPem);
fs.writeFileSync(path.join(dir, 'public.pem'), pubPem);

const out = [
  '=== private.pem (服务端保密，绝不发给客户端) ===',
  privPem,
  '=== public.pem (客户端可持) ===',
  pubPem,
  '=== SERVER_PUBLIC_KEY (SPKI base64，嵌入客户端 HTML) ===',
  pubSpkiB64,
].join('\n');

fs.writeFileSync(path.join(__dirname, 'keys_out.txt'), out, 'utf-8');
console.log('KEYS_GENERATED');
console.log('SPKI_B64=' + pubSpkiB64);
