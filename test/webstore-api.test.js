const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'publish-chrome-store.yml');
const scriptPath = path.join(root, 'scripts', 'publish-chrome-store.sh');

assert(fs.existsSync(workflowPath), 'Chrome Web Store publish workflow exists');
assert(fs.existsSync(scriptPath), 'Chrome Web Store publish script exists');

const workflow = fs.readFileSync(workflowPath, 'utf8');
const script = fs.readFileSync(scriptPath, 'utf8');

assert(/workflow_dispatch:/.test(workflow), 'publishing requires an explicit manual dispatch');
assert(/CWS_SERVICE_ACCOUNT_JSON/.test(workflow), 'service account credential comes from a GitHub Secret');
assert(/token_format:\s*access_token/.test(workflow), 'workflow requests a short-lived access token');
assert(/chromewebstore\.googleapis\.com/.test(script) && /\/upload\/v2\//.test(script),
  'script uses the Web Store V2 upload endpoint');
assert(/:fetchStatus/.test(script), 'script verifies the uploaded revision');
assert(/:publish/.test(script), 'script submits the revision for review');
assert(!/(client_secret|refresh_token)\s*[:=]\s*["'][^"']+/i.test(workflow + script),
  'no OAuth client secret or refresh token is committed');

console.log('Chrome Web Store API publishing configuration: PASS');
