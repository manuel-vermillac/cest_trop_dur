#!/bin/bash
# Lancer le serveur C'est Trop Dur avec Tailscale Funnel
echo "Demarrage du serveur C'est Trop Dur..."
echo ""

# Lancer tailscale funnel en arriere-plan
tailscale funnel 5016 &
FUNNEL_PID=$!

echo "Tailscale Funnel active sur le port 5016"
echo ""

# Lancer le serveur Flask
cd "$(dirname "$0")"
python3 app.py

# Arreter funnel quand le serveur s'arrete
kill $FUNNEL_PID 2>/dev/null
