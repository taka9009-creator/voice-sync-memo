const { spawn } = require('child_process');

function startTunnel() {
  console.log('[Tunnel] Starting localtunnel...');
  const child = spawn('cmd.exe', ['/c', 'npx.cmd', '--yes', 'localtunnel', '--port', '3000', '--subdomain', 'voicesync-memo'], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    console.log(`[Tunnel] Exited with code ${code}. Restarting in 2 seconds...`);
    setTimeout(startTunnel, 2000);
  });

  child.on('error', (err) => {
    console.error('[Tunnel] Error:', err);
    setTimeout(startTunnel, 3000);
  });
}

startTunnel();
