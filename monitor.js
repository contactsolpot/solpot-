// ============================================================
// SOLPOT TERMINAL MONITOR — Live Cyberpunk Admin Dashboard
// ============================================================

const https = require('https');
const http = require('http');

const TARGET_HOST = process.env.ADMIN_HOST || 'https://thesolpot.fun';
const ADMIN_KEY = process.env.ADMIN_KEY || '##solpotadmin2026##solana##';

console.clear();

function formatSol(val) {
  return (Number(val) || 0).toFixed(4) + ' SOL';
}

function fetchOverview() {
  const url = `${TARGET_HOST}/api/admin/overview?secret=${ADMIN_KEY}`;
  const client = url.startsWith('https') ? https : http;

  client.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        renderScreen(json);
      } catch (e) {
        console.log(`\x1b[31m[ERRO]\x1b[0m Falha ao processar dados: ${e.message}`);
      }
    });
  }).on('error', (err) => {
    console.log(`\x1b[31m[ERRO DE CONEXÃO]\x1b[0m Não foi possível conectar a ${TARGET_HOST}: ${err.message}`);
  });
}

function renderScreen(data) {
  const gs = data.gameState || {};
  const bal = data.balances || {};
  const cum = data.cumulative || {};
  const errors = data.recentErrors || [];
  const events = data.recentEvents || [];
  const chat = data.chatMessages || [];

  let timerStr = '--:--';
  if (gs.deadline) {
    const diff = Math.max(0, Math.floor((gs.deadline - Date.now()) / 1000));
    const m = String(Math.floor(diff / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    timerStr = `${m}:${s}`;
  }

  const nowStr = new Date().toLocaleTimeString();

  // Color Codes
  const C_CYAN = '\x1b[36m';
  const C_GREEN = '\x1b[32m';
  const C_YELLOW = '\x1b[33m';
  const C_RED = '\x1b[31m';
  const C_MAGENTA = '\x1b[35m';
  const C_RESET = '\x1b[0m';
  const C_BOLD = '\x1b[1m';

  let output = '';
  output += `\x1b[H`; // Move cursor to top-left instead of clear to prevent flickering

  output += `${C_MAGENTA}${C_BOLD}╔════════════════════════════════════════════════════════════════════════════════╗${C_RESET}\n`;
  output += `${C_MAGENTA}${C_BOLD}║${C_RESET}  ${C_CYAN}${C_BOLD}⚡ SOLPOT ADMIN COMMAND TERMINAL${C_RESET}  —  ${C_GREEN}LIVE MAINNET MONITOR${C_RESET}    ${C_YELLOW}[${nowStr}]${C_RESET}  ${C_MAGENTA}${C_BOLD}║${C_RESET}\n`;
  output += `${C_MAGENTA}${C_BOLD}╚════════════════════════════════════════════════════════════════════════════════╝${C_RESET}\n\n`;

  // 1. Live Users & Status
  output += `  ${C_BOLD}STATUS DO SERVIDOR:${C_RESET} ${C_GREEN}● ONLINE${C_RESET}   │   ${C_BOLD}👥 VISITANTES ONLINE:${C_RESET} ${C_GREEN}${C_BOLD}${data.onlineUsers || 0} pessoas no site${C_RESET}\n`;
  output += `  ${C_BOLD}RODADA ATUAL:${C_RESET} ${C_CYAN}#${gs.round || 1}${C_RESET}      │   ${C_BOLD}⏱️ CRONÔMETRO:${C_RESET} ${C_YELLOW}${C_BOLD}${timerStr}${C_RESET}\n\n`;

  // 2. Financial Vaults Table
  output += `${C_CYAN}┌─── 💰 SALDOS ON-CHAIN & COFRES ────────────────────────────────────────────────┐${C_RESET}\n`;
  output += `│  👑 Lucro Dev (Platform Vault): ${C_YELLOW}${C_BOLD}${formatSol(bal.platformVaultSol)}${C_RESET} (Acumulado Total: ${formatSol(cum.totalPlatformFeesEarnedSol)})\n`;
  output += `│  🏦 Carteira Hot do Jogo:       ${C_CYAN}${formatSol(bal.serverWalletSol)}${C_RESET} (${bal.serverWalletAddr ? bal.serverWalletAddr.slice(0, 8) + '...' : ''})\n`;
  output += `│  💎 Holder Vault (Airdrop):     ${C_MAGENTA}${formatSol(bal.holderVaultSol)}${C_RESET}\n`;
  output += `│  🔥 Fundo de Buy & Burn:        ${C_YELLOW}${formatSol(gs.buyBurnPoolSol)}${C_RESET} / 0.0200 SOL\n`;
  output += `│  📈 Volume Total Apostado:      ${C_GREEN}${C_BOLD}${formatSol(cum.totalVolumeSol)}${C_RESET} em ${cum.totalRounds || 0} rodadas\n`;
  output += `${C_CYAN}└────────────────────────────────────────────────────────────────────────────────┘${C_RESET}\n\n`;

  // 3. Current Pot Status
  output += `${C_GREEN}┌─── 🎲 POTES DA RODADA #${gs.round || 1} ──────────────────────────────────────────────────┐${C_RESET}\n`;
  output += `│  🏆 Jackpot Principal (80%):  ${C_GREEN}${C_BOLD}${formatSol(gs.potSol)}${C_RESET}\n`;
  output += `│  🎲 Sorteio Lucky Draw (5%):  ${C_CYAN}${formatSol(gs.luckyPoolSol)}${C_RESET}\n`;
  output += `│  🥇 Ranking Top 10 (5%):      ${C_YELLOW}${formatSol(gs.rankingPoolSol)}${C_RESET}\n`;
  output += `│  👑 Líder Atual:              ${gs.leader ? `${C_BOLD}${gs.leader.address.slice(0,6)}...${gs.leader.address.slice(-4)}${C_RESET} (${gs.leader.amountSol} SOL)` : 'Aguardando lance...'}\n`;
  output += `${C_GREEN}└────────────────────────────────────────────────────────────────────────────────┘${C_RESET}\n\n`;

  // 4. Incident & Error Stream
  if (errors.length > 0) {
    output += `${C_RED}${C_BOLD}┌─── 🚨 ERROS & ALERTAS DETECTADOS (${errors.length}) ──────────────────────────────────────┐${C_RESET}\n`;
    errors.slice(0, 3).forEach(e => {
      output += `${C_RED}│  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.type}: ${e.message.slice(0, 65)}${C_RESET}\n`;
    });
    output += `${C_RED}└────────────────────────────────────────────────────────────────────────────────┘${C_RESET}\n\n`;
  } else {
    output += `  ${C_GREEN}✅ NENHUM ERRO DETECTADO. Todos os RPCs e pagamentos funcionando 100%.${C_RESET}\n\n`;
  }

  // 5. Live Chat Stream
  output += `${C_MAGENTA}┌─── 💬 CHAT DOS JOGADORES AO VIVO (Últimas mensagens) ──────────────────────────┐${C_RESET}\n`;
  if (chat.length === 0) {
    output += `│  (Nenhuma mensagem recente no chat)\n`;
  } else {
    chat.slice(-4).forEach(m => {
      output += `│  ${C_BOLD}${m.sender}${C_RESET}: ${m.text.slice(0, 60)}\n`;
    });
  }
  output += `${C_MAGENTA}└────────────────────────────────────────────────────────────────────────────────┘${C_RESET}\n\n`;

  // 6. Recent On-Chain Bids/Events
  output += `${C_CYAN}┌─── ⚡ ÚLTIMOS EVENTOS & LANCES ON-CHAIN ────────────────────────────────────────┐${C_RESET}\n`;
  if (events.length === 0) {
    output += `│  (Aguardando eventos...)\n`;
  } else {
    events.slice(0, 4).forEach(ev => {
      output += `│  [${new Date(ev.timestamp).toLocaleTimeString()}] ${ev.message.slice(0, 70)}\n`;
    });
  }
  output += `${C_CYAN}└────────────────────────────────────────────────────────────────────────────────┘${C_RESET}\n`;

  output += `\n  ${C_YELLOW}Pressione Ctrl + C para fechar o terminal de monitoramento.${C_RESET}\n`;

  process.stdout.write(output);
}

// Polling a cada 2 segundos
fetchOverview();
setInterval(fetchOverview, 2000);
