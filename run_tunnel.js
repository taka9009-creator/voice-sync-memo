const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL_FILE = path.join(__dirname, 'tunnel_url.txt');

function startTunnel() {
  console.log('[Tunnel] Starting persistent localtunnel on port 3333...');
  const child = spawn('cmd.exe', ['/c', 'npx.cmd', '--yes', 'localtunnel', '--port', '3333'], {
    shell: true
  });

  child.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(text);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.loca\.lt/);
    if (match) {
      const url = match[0];
      fs.writeFileSync(URL_FILE, url, 'utf8');
      console.log('[Tunnel] Active URL saved to tunnel_url.txt:', url);
    }
  });

  child.stderr.on('data', (data) => {
    console.error('[Tunnel Error]', data.toString());
  });

  child.on('close', (code) => {
    console.log(`[Tunnel] Exited with code ${code}. Auto-restarting in 2s...`);
    setTimeout(startTunnel, 2000);
  });

  child.on('error', (err) => {
    console.error('[Tunnel Failed]', err);
    setTimeout(startTunnel, 3000);
  });
}

startTunnel();
