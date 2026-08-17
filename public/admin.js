// ==================== SOLPOT ADMIN SCRIPT ====================
let adminSecret = localStorage.getItem('solpot_admin_key') || '';
let isPolling = false;

function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

async function authenticateAdmin() {
  const input = $('admin-pass-input').value.trim();
  if (!input) return;

  try {
    const res = await fetch(`/api/admin/overview?secret=${encodeURIComponent(input)}`);
    if (res.ok) {
      adminSecret = input;
      localStorage.setItem('solpot_admin_key', adminSecret);
      $('auth-modal').style.display = 'none';
      $('admin-content').style.display = 'block';
      $('auth-error').style.display = 'none';
      startAdminLoop();
    } else {
      $('auth-error').style.display = 'block';
    }
  } catch (err) {
    alert('Erro ao conectar ao servidor: ' + err.message);
  }
}

function logoutAdmin() {
  localStorage.removeItem('solpot_admin_key');
  adminSecret = '';
  location.reload();
}

async function fetchAdminData() {
  if (!adminSecret) return;

  try {
    const res = await fetch(`/api/admin/overview?secret=${encodeURIComponent(adminSecret)}`);
    if (!res.ok) {
      if (res.status === 401) logoutAdmin();
      return;
    }

    const data = await res.json();
    renderDashboard(data);
  } catch (err) {
    console.error('Erro no polling do admin:', err);
  }
}

function renderDashboard(data) {
  // 1. Visitantes Online
  $('val-online').innerText = data.onlineUsers || 0;

  // 2. Saldos On-Chain
  if (data.balances) {
    $('val-server-bal').innerText = (data.balances.serverWalletSol || 0).toFixed(4) + ' SOL';
    $('val-dev-vault').innerText = (data.balances.platformVaultSol || 0).toFixed(4) + ' SOL';
    $('val-holder-vault').innerText = (data.balances.holderVaultSol || 0).toFixed(4) + ' SOL';

    if (data.balances.serverWalletAddr) {
      const a = data.balances.serverWalletAddr;
      $('val-server-addr').innerText = `${a.slice(0, 4)}...${a.slice(-4)}`;
    }
  }

  // 3. Cumulativos
  if (data.cumulative) {
    $('val-dev-accum').innerText = `Acumulado total: ${(data.cumulative.totalPlatformFeesEarnedSol || 0).toFixed(4)} SOL`;
    $('val-total-volume').innerText = `${(data.cumulative.totalVolumeSol || 0).toFixed(3)} SOL`;
    $('val-total-rounds').innerText = `${data.cumulative.totalRounds || 0} rodadas finalizadas`;
  }

  // 4. Status do Jogo Atual
  const gs = data.gameState || {};
  $('round-badge').innerText = `RODADA #${gs.round || 1}`;
  $('val-jackpot').innerText = `${(gs.potSol || 0).toFixed(3)} SOL`;
  $('val-lucky-pot').innerText = `${(gs.luckyPoolSol || 0).toFixed(3)} SOL`;
  $('val-ranking-pot').innerText = `${(gs.rankingPoolSol || 0).toFixed(3)} SOL`;
  $('val-buyburn').innerText = `${(gs.buyBurnPoolSol || 0).toFixed(4)} SOL`;

  if (gs.leader) {
    const l = gs.leader.address;
    $('val-leader').innerText = `${l.slice(0, 6)}...${l.slice(-4)} (${gs.leader.amountSol} SOL)`;
  } else {
    $('val-leader').innerText = 'Aguardando primeiro lance';
  }

  if (gs.deadline) {
    const diff = Math.max(0, Math.floor((gs.deadline - Date.now()) / 1000));
    const m = String(Math.floor(diff / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    $('val-timer').innerText = `${m}:${s}`;
  } else {
    $('val-timer').innerText = '--:--';
  }

  // 5. Alertas & Incidentes
  const errors = data.recentErrors || [];
  if (errors.length > 0) {
    $('incident-banner').classList.remove('hidden');
    $('incident-text').innerText = `🚨 ${errors.length} erro(s) detectado(s): ${errors[0].type} — ${errors[0].message}`;
  } else {
    $('incident-banner').classList.add('hidden');
  }

  // Renderizar Stream de Erros
  const errStream = $('error-stream');
  if (errors.length === 0) {
    errStream.innerHTML = `<div class="log-item"><span>✅ Nenhum erro registrado. Todos os pagamentos e RPCs operando 100%.</span></div>`;
  } else {
    errStream.innerHTML = errors.map(e => `
      <div class="log-item error">
        <div>
          <strong>[${escapeHtml(e.type)}]</strong> ${escapeHtml(e.message)}
          ${e.details?.winner ? `<div style="font-size:0.7rem;color:#fca5a5;">Carteira: ${e.details.winner} | ${e.details.potSol} SOL</div>` : ''}
        </div>
        <div class="log-time">${new Date(e.timestamp).toLocaleTimeString()}</div>
      </div>
    `).join('');
  }

  // Renderizar Feed de Eventos
  const evStream = $('event-stream');
  const events = data.recentEvents || [];
  if (events.length === 0) {
    evStream.innerHTML = `<div class="log-item"><span>Aguardando lances e pagamentos...</span></div>`;
  } else {
    evStream.innerHTML = events.slice(0, 30).map(ev => {
      let cls = 'log-item';
      if (ev.isError) cls += ' error';
      else if (ev.type.includes('BID')) cls += ' bid';
      else if (ev.type.includes('PAYOUT') || ev.type.includes('DRAW')) cls += ' payout';

      return `
        <div class="${cls}">
          <div>
            <strong>[${escapeHtml(ev.type)}]</strong> ${escapeHtml(ev.message)}
            ${ev.details?.solscanUrl ? ` <a href="${ev.details.solscanUrl}" target="_blank" style="color:var(--green);text-decoration:underline;">Ver Solscan ↗</a>` : ''}
          </div>
          <div class="log-time">${new Date(ev.timestamp).toLocaleTimeString()}</div>
        </div>
      `;
    }).join('');
  }

  // Renderizar Chat ao Vivo
  const chatBox = $('admin-chat-box');
  const chat = data.chatMessages || [];
  if (chat.length === 0) {
    chatBox.innerHTML = `<div class="chat-msg">Nenhuma mensagem no chat.</div>`;
  } else {
    chatBox.innerHTML = chat.slice(-25).map(m => `
      <div class="chat-msg">
        <span class="chat-author ${m.isSystem ? 'dev' : ''}">${escapeHtml(m.sender)}:</span>
        <span class="chat-text">${escapeHtml(m.text)}</span>
      </div>
    `).join('');
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // Renderizar Vencedores Recentes
  const winStream = $('winners-history');
  const history = gs.history || [];
  if (history.length === 0) {
    winStream.innerHTML = `<div class="log-item"><span>Nenhum vencedor ainda.</span></div>`;
  } else {
    winStream.innerHTML = history.slice(0, 10).map(h => `
      <div class="log-item payout">
        <div>
          <strong>#${h.round}</strong> 👑 ${h.winner.slice(0, 4)}...${h.winner.slice(-4)} ganhou <strong>${(h.potSol || 0).toFixed(3)} SOL</strong>
          ${h.luckyWinner ? `<span style="color:var(--cyan);"> | 🎲 Lucky: ${h.luckyWinner.address.slice(0, 4)}... (+${h.luckyWinner.prizeSol.toFixed(3)} SOL)</span>` : ''}
        </div>
        <div class="log-time">${new Date(h.endedAt).toLocaleTimeString()}</div>
      </div>
    `).join('');
  }
}

async function sendAdminChat() {
  const input = $('admin-msg-input');
  const text = input.value.trim();
  if (!text) return;

  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: '👑 DEV/ADMIN', text, isAdmin: true, isVip: true })
    });
    input.value = '';
    fetchAdminData();
  } catch (e) {
    alert('Erro ao enviar mensagem: ' + e.message);
  }
}

async function clearChat() {
  if (!confirm('Deseja realmente limpar todas as mensagens do chat dos jogadores?')) return;
  try {
    const res = await fetch(`/api/admin/clear-chat?secret=${encodeURIComponent(adminSecret)}`, { method: 'POST' });
    if (res.ok) fetchAdminData();
  } catch (e) {
    alert('Erro ao limpar chat: ' + e.message);
  }
}

async function clearErrorLogs() {
  try {
    const res = await fetch(`/api/admin/clear-errors?secret=${encodeURIComponent(adminSecret)}`, { method: 'POST' });
    if (res.ok) fetchAdminData();
  } catch (e) {
    alert('Erro ao limpar erros: ' + e.message);
  }
}

async function triggerHolderDraw() {
  if (!confirm('Deseja disparar o sorteio do Holder Vault agora?')) return;
  try {
    const res = await fetch('/api/trigger-holder-airdrop', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(`🎉 Sorteio Realizado!\nGanhador: ${data.winner}\nPrêmio: ${data.prizeSol.toFixed(3)} SOL`);
      fetchAdminData();
    } else {
      alert('Erro: ' + data.error);
    }
  } catch (e) {
    alert('Erro ao disparar sorteio: ' + e.message);
  }
}

function startAdminLoop() {
  if (isPolling) return;
  isPolling = true;
  fetchAdminData();
  setInterval(fetchAdminData, 2000);
}

// Auto-login se chave já estiver salva
window.addEventListener('DOMContentLoaded', () => {
  if (adminSecret) {
    $('admin-pass-input').value = adminSecret;
    authenticateAdmin();
  }
});
