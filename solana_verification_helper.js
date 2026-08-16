// --------------------------------------------------------------------------------
// SOLANA ON-CHAIN TOKEN BALANCE VERIFIER (@solana/web3.js)
// Como o SolPot verifica se o jogador possui 10.000+ $SOLPOT na carteira
// --------------------------------------------------------------------------------

const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// Conexão oficial com a rede Solana (RPC Mainnet ou Devnet)
const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

/**
 * Função que verifica o saldo de tokens de uma carteira na Solana
 * @param {string} walletAddress - Endereço público da Phantom do jogador
 * @param {string} tokenMintAddress - Endereço Mint do token no pump.fun
 * @returns {Promise<{balance: number, tickets: number, isVip: boolean, eligible: boolean}>}
 */
async function verifyTokenBalance(walletAddress, tokenMintAddress) {
  try {
    const ownerPublicKey = new PublicKey(walletAddress);
    const mintPublicKey = new PublicKey(tokenMintAddress);

    // Consulta na blockchain Solana todas as contas de token pertencentes à carteira
    const response = await connection.getParsedTokenAccountsByOwner(
      ownerPublicKey,
      { mint: mintPublicKey }
    );

    let totalTokens = 0;

    // Soma o saldo de todas as contas associadas
    for (const accountInfo of response.value) {
      const parsedInfo = accountInfo.account.data.parsed.info;
      const amount = parsedInfo.tokenAmount.uiAmount || 0;
      totalTokens += amount;
    }

    const minRequired = 10000; // 10k tokens = 1 Ticket
    const vipRequired = 100000; // 100k tokens = VIP (25% Desconto)

    const tickets = Math.floor(totalTokens / minRequired);
    const isVip = totalTokens >= vipRequired;
    const eligible = tickets >= 1;

    return {
      walletAddress,
      balance: totalTokens,
      tickets,
      isVip,
      eligible
    };
  } catch (error) {
    console.error('Erro ao consultar saldo na Solana RPC:', error);
    return { walletAddress, balance: 0, tickets: 0, isVip: false, eligible: false };
  }
}

module.exports = { verifyTokenBalance };
