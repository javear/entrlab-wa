import vault from 'node-vault';

// Lazy initialization - don't check env vars at module load time
let vaultClient: any = null;
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
    console.log('✅ Vault client initialized');
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
function getVaultKeyName(): string {
  return process.env.VAULT_KEY_NAME || 'automark-key';
}

/**
 * Encrypt data with Vault
 * @param data - Data object to encrypt
 * @param context - Optional context for encryption
 * @returns Encrypted ciphertext
 */
export async function encryptWithVault(data: any, context: string | null = null): Promise<string> {
  // Lazy initialization - check env vars when function is called
  const client = initializeVaultClient();
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const vaultKeyName = getVaultKeyName();

  if (!vaultAddr || !vaultToken || !client) {
    throw new Error('Vault is not configured. Please set VAULT_ADDR and VAULT_TOKEN in your .env file');
  }

  try {
    console.log('🔐 Encrypting data with Vault...');
    console.log('   Vault address:', vaultAddr);
    console.log('   Key name:', vaultKeyName);
    console.log('   Context provided:', !!context);

    // Prepare data for encryption
    const plaintext = Buffer.from(JSON.stringify(data)).toString('base64');
    
    // Prepare encrypt payload
    const encryptPayload: any = { plaintext };
    if (context) {
      encryptPayload.context = Buffer.from(context).toString('base64');
    }

    // Encrypt using Transit engine
    const encryptRes = await client.write(`automark-transit/encrypt/${vaultKeyName}`, encryptPayload);

    console.log('✅ Vault encryption successful');
    return encryptRes.data.ciphertext;
  } catch (error: any) {
    console.error('❌ Vault encryption failed:', error.message);
    throw error;
  }
}

/**
 * Decrypt data with Vault
 * @param ciphertext - Encrypted ciphertext
 * @param context - Optional context for decryption
 * @returns Decrypted data object
 */
export async function decryptWithVault(ciphertext: string, context: string | null = null): Promise<any> {
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
    
    // Prepare decrypt payload
    const decryptPayload: any = { ciphertext };
    if (context) {
      decryptPayload.context = Buffer.from(context).toString('base64');
    }

    // Decrypt using Transit engine
    const decryptRes = await client.write(`automark-transit/decrypt/${vaultKeyName}`, decryptPayload);

    // Decode the base64 plaintext back to JSON
    const plaintext = Buffer.from(decryptRes.data.plaintext, 'base64').toString('utf8');
    const data = JSON.parse(plaintext);

    console.log('✅ Vault decryption successful');
    return data;
  } catch (error: any) {
    console.error('❌ Vault decryption failed:', error.message);
    throw error;
  }
}

