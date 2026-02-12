# SSH Sanity Checks (Sol-Trader)

Short command list for quick verification on the VPS.

## Config and Mode

Show `.env`:
```bash
cat /opt/sol-trader/.env
```

Show with line numbers:
```bash
nl -ba /opt/sol-trader/.env
```

Confirm `UNIVERSE_MODE` in logs:
```bash
journalctl -u sol-trader -n 200 --no-pager | grep -i "universeMode"
```

## Service Health

Check service status:
```bash
sudo systemctl status sol-trader --no-pager
```

Restart service:
```bash
sudo systemctl restart sol-trader
```

Tail logs:
```bash
journalctl -u sol-trader -f
```

## API / Dashboard

Local API status:
```bash
curl http://127.0.0.1:3847/api/status
```

Metrics:
```bash
curl http://127.0.0.1:3847/api/metrics
```

Go-live gates:
```bash
curl http://127.0.0.1:3847/api/gates
```

## Trading Signals

Last 50 entry signals:
```bash
journalctl -u sol-trader -n 1000 --no-pager | grep -i "ENTRY SIGNAL" | tail -n 50
```

Count entry signals in last 30 minutes:
```bash
journalctl -u sol-trader --since "30 min ago" | grep -c "ENTRY SIGNAL"
```

## Universe / Watchlist

Show watchlist file:
```bash
cat /opt/sol-trader/config/watchlist.json
```

## Sanity Checks

Confirm process is running:
```bash
pgrep -fa sol-trader
```

Check disk usage:
```bash
df -h /opt
```

Check memory:
```bash
free -h
```

Check node and npm versions:
```bash
node -v
npm -v
```
