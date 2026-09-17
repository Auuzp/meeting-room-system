const fs = require('fs');
const path = require('path');
const os = require('os');

function findKey() {
  const localCandidates = fs.readdirSync(path.join(__dirname, '..'))
    .filter(f => f.endsWith('.json') && !['package.json', 'package-lock.json', 'tsconfig.json'].includes(f))
    .map(f => path.join(__dirname, '..', f));

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  let downloadCandidates = [];
  if (fs.existsSync(downloadsDir)) {
    downloadCandidates = fs.readdirSync(downloadsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(downloadsDir, f));
  }

  const all = [...localCandidates, ...downloadCandidates];
  for (const file of all) {
    try {
      const content = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (content.type === 'service_account' && content.project_id && content.private_key) {
        return { file, content };
      }
    } catch (e) {
      // not a valid json or permission error
    }
  }
  return null;
}

const found = findKey();
if (found) {
  console.log(JSON.stringify({
    success: true,
    file: found.file,
    projectId: found.content.project_id,
    clientEmail: found.content.client_email
  }));
} else {
  console.log(JSON.stringify({ success: false }));
}
