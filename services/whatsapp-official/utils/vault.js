// Re-export Vault utilities from main src/utils/vault.ts
// Since this is a JS service, we'll create a compatible version

// Note: This is a bridge file. For production, you might want to compile the TS utils to JS
// or use a different approach. For now, we'll use a simple require pattern.

// This will only work if the TypeScript is compiled to JavaScript first
// For now, let's create a JavaScript version

const vault = require('node-vault');

// Lazy initialization - don't check env vars at module load time
let vaultClient = null;
let vaultClientInitialized = false;

/**
 * Initialize Vault client lazily (only when needed)
 */
function initializeVaultClient() {
  if (vaultClientInitialized) {
    return vaultClient;
  }

  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    vaultClientInitialized = true; // Mark as initialized to avoid repeated checks
    return null;
  }

  try {
    vaultClient = vault({
      apiVersion: 'v1',
      endpoint: vaultAddr,
      token: vaultToken,
    });
    vaultClientInitialized = true;
    console.log('✅ Vault client initialized for WhatsApp Official service');
    return vaultClient;
  } catch (error) {
    console.error('❌ Failed to initialize Vault client:', error);
    vaultClientInitialized = true;
    return null;
  }
}

/**
 * Get Vault key name from environment
 */
function getVaultKeyName() {
  return process.env.VAULT_KEY_NAME || 'automark-key';
}

/**
 * Decrypt data with Vault
 */
async function decryptWithVault(ciphertext, context = null) {
  // Lazy initialization - check env vars when function is called
  const client = initializeVaultClient();
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const vaultKeyName = getVaultKeyName();

  if (!vaultAddr || !vaultToken || !client) {
    throw new Error('Vault is not configured. Please set VAULT_ADDR and VAULT_TOKEN in your .env file');
  }

  try {
    console.log('🔓 Decrypting data with Vault...');
    
    const decryptPayload = { ciphertext };
    if (context) {
      decryptPayload.context = Buffer.from(context).toString('base64');
    }

    const decryptRes = await client.write(`automark-transit/decrypt/${vaultKeyName}`, decryptPayload);

    const plaintext = Buffer.from(decryptRes.data.plaintext, 'base64').toString('utf8');
    const data = JSON.parse(plaintext);

    console.log('✅ Vault decryption successful');
    return data;
  } catch (error) {
    console.error('❌ Vault decryption failed:', error.message);
    throw error;
  }
}

module.exports = { decryptWithVault };

