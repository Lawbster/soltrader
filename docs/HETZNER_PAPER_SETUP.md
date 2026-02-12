# Hetzner VPS Setup (Paper Trading)

This is a step-by-step runbook to deploy `sol-trader` on a Hetzner Cloud VPS for a 14-day paper-trading run.

## 0) Prerequisites (local machine)

1. Have these ready:
- Hetzner account
- GitHub access to this repo
- Helius API key + RPC/WSS URLs
- SSH key pair (`ed25519` recommended)

2. If you do not have an SSH key yet:
```bash
ssh-keygen -t ed25519 -C "sol-trader-vps"
```

## 1) Create the Hetzner server

In Hetzner Cloud Console:

1. Create/select a project.
2. Add your SSH public key in the project.
3. Create server:
- Image: Ubuntu 24.04 LTS (or Ubuntu 22.04 LTS)
- Type: shared vCPU is fine for paper mode (start small, scale later)
- Location: closest to you / closest to Solana RPC latency target
- Authentication: select SSH key (do not use password-only login)
4. Optionally enable daily Backups now.
5. Create the server and note its IPv4.

## 2) Create and attach firewall (Hetzner + OS)

### Hetzner Cloud Firewall (recommended)

Allow inbound only:
- TCP 22 from your home IP
- TCP 3847 from your home IP (only if you want direct dashboard access)

If you will use SSH tunneling for dashboard, you can skip opening 3847 publicly.

### OS firewall (UFW)

SSH into server:
```bash
ssh root@<SERVER_IP>
```

Then:
```bash
apt update && apt upgrade -y
apt install -y ufw fail2ban git curl ca-certificates
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
# optional direct dashboard access:
# ufw allow from <YOUR_PUBLIC_IP>/32 to any port 3847 proto tcp
ufw enable
systemctl enable --now fail2ban
```

## 3) Create a non-root deploy user

```bash
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Optional hardening (`/etc/ssh/sshd_config`):
- `PermitRootLogin prohibit-password`
- `PasswordAuthentication no`

Then:
```bash
systemctl restart ssh
```

Reconnect as deploy user:
```bash
ssh deploy@<SERVER_IP>
```

## 4) Install Node.js and app dependencies

Use Node 20 LTS:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v
npm -v
```

Deploy app:
```bash
sudo mkdir -p /opt/sol-trader
sudo chown -R deploy:deploy /opt/sol-trader
git clone <YOUR_REPO_URL> /opt/sol-trader
cd /opt/sol-trader/sol-trader
npm install
npm run build
npm test
```

## 5) Configure environment for paper mode

Create `.env` on VPS:
```bash
cp .env.example .env
nano .env
```

Set at minimum:
- `PAPER_TRADING=true`
- `HELIUS_API_KEY=...`
- `HELIUS_RPC_URL=...`
- `HELIUS_WSS_URL=...`
- `DASHBOARD_PORT=3847`

Important paper-mode note:
- Position sizing/risk uses wallet balance as equity.
- If you leave wallet empty/ephemeral at 0 SOL, entries may be blocked by exposure checks.
- Use a wallet with small SOL balance for realistic equity reference (even in paper mode).

Security note:
- If any private key/API key was ever exposed in screenshots/chats/commits, rotate it before VPS deployment.

## 6) Run once manually (smoke test)

```bash
cd /opt/sol-trader/sol-trader
npm start
```

Validate:
- logs show monitor + strategy loops running
- dashboard available locally on server:
```bash
curl http://127.0.0.1:3847/api/status
```

If you do not expose 3847 publicly, use SSH tunnel from your laptop:
```bash
ssh -L 3847:127.0.0.1:3847 deploy@<SERVER_IP>
```
Then open `http://localhost:3847` locally.

## 7) Run as a systemd service (24/7)

Create service file:
```bash
sudo tee /etc/systemd/system/sol-trader.service > /dev/null <<'EOF'
[Unit]
Description=Sol-Trader Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/sol-trader/sol-trader
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sol-trader
sudo systemctl status sol-trader --no-pager
```

Logs:
```bash
journalctl -u sol-trader -f
```

## 8) 14-day paper test operations

Daily checks:
1. Service health:
```bash
systemctl is-active sol-trader
```
2. Metrics file exists and updates:
- `sol-trader/data/metrics.json`
3. Dashboard/API checks:
- `/api/metrics`
- `/api/gates`
- `/api/status`
4. Keep strategy config stable during sample period.

At day 14:
- Evaluate against `sol-trader/docs/LIVE_GATES.md`
- Require minimum 120 trades and all threshold gates

## 9) Safe update workflow (without losing control)

When you need to update code:
```bash
cd /opt/sol-trader
# pull changes as needed
cd /opt/sol-trader/sol-trader
npm install
npm test
sudo systemctl restart sol-trader
journalctl -u sol-trader -n 100 --no-pager
```

## 10) Rollback shortcut

Keep a tagged/known-good commit hash. If a deploy fails:
```bash
cd /opt/sol-trader
git checkout <KNOWN_GOOD_COMMIT>
cd /opt/sol-trader/sol-trader
npm install
sudo systemctl restart sol-trader
```

---

## Official Hetzner References

- Creating a server: https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server
- Connecting via SSH: https://docs.hetzner.com/cloud/servers/getting-started/connecting-to-the-server
- Creating a firewall: https://docs.hetzner.com/cloud/firewalls/getting-started/creating-a-firewall
- Firewalls overview/limits: https://docs.hetzner.com/cloud/firewalls/overview/
- Enabling backups: https://docs.hetzner.com/cloud/servers/getting-started/enabling-backups
- Taking snapshots: https://docs.hetzner.com/cloud/servers/getting-started/taking-snapshots
- SSH key FAQ (existing server caveat): https://docs.hetzner.com/cloud/servers/faq
