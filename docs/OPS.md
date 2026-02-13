# Ops — VPS Setup & Daily Checks

## 1) VPS Setup (Hetzner)
High‑level steps for paper trading on Ubuntu 22.04/24.04.

1. Create server and add SSH key.
2. SSH in as root:
   - `ssh root@<SERVER_IP>`
3. Basic hardening:
   - `apt update && apt upgrade -y`
   - `apt install -y ufw fail2ban git curl ca-certificates`
   - `ufw default deny incoming`
   - `ufw default allow outgoing`
   - `ufw allow 22/tcp`
   - `ufw enable`
   - `systemctl enable --now fail2ban`
4. Create deploy user:
   - `adduser deploy`
   - `usermod -aG sudo deploy`
   - copy SSH keys to `/home/deploy/.ssh/authorized_keys`

## 2) Install Node + App
```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v
npm -v
```

```
sudo mkdir -p /opt/sol-trader
sudo chown -R deploy:deploy /opt/sol-trader
git clone <YOUR_REPO_URL> /opt/sol-trader
cd /opt/sol-trader
npm install
npm run build
```

## 3) Configure `.env`
```
cp .env.example .env
nano .env
```
Required:
- `PAPER_TRADING=true`
- `UNIVERSE_MODE=watchlist`
- `HELIUS_*` values
- `DASHBOARD_PORT=3847`

## 4) Run with systemd
```
sudo tee /etc/systemd/system/sol-trader.service > /dev/null <<'EOF'
[Unit]
Description=Sol-Trader Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/sol-trader
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now sol-trader
sudo systemctl status sol-trader --no-pager
```

## 5) Dashboard Access (SSH Tunnel)
```
ssh -L 3847:127.0.0.1:3847 deploy@<SERVER_IP>
```
Open `http://localhost:3847`

## 6) Daily Checks
```
systemctl is-active sol-trader
curl http://127.0.0.1:3847/api/status
curl http://127.0.0.1:3847/api/metrics
journalctl -u sol-trader -n 50 --no-pager
```

## 7) Update Workflow
```
cd /opt/sol-trader
git pull
npm install
npm run build
sudo systemctl restart sol-trader
journalctl -u sol-trader -n 50 --no-pager
```
