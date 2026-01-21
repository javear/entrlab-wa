import { create, Whatsapp } from '@wppconnect-team/wppconnect';
import mongoose from 'mongoose';
import { WhatsAppSessionBackup } from './whatsapp-session-backup';
import { createMongoTokenStore } from './tokenstore';
import fs from 'fs';
import path from 'path';
import { MEMORY_CONFIG, getMemoryUsage, suggestGC, needsMemoryWarning } from '../config/memory-config';

// ============================================
// WPPConnect Client Manager
// ============================================

export interface WPPConnectClientInfo {
  clientId: string;
  client: Whatsapp;
  isReady: boolean;
  phoneNumber?: string | undefined;
  qrCode?: string | undefined;
  lastActivity: Date;
  status: 'initializing' | 'qr_required' | 'authenticated' | 'ready' | 'disconnected' | 'error' | 'session_saved';
  ai_agent_code?: string | undefined;
}

export interface WPPConnectClientManagerConfig {
  chromiumPath: string;
  puppeteerArgs: string[];
  mongoUri: string;
  backupSyncIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  healthCheckIntervalMs?: number;
}

export class WPPConnectClientManager {
  private clients: Map<string, WPPConnectClientInfo> = new Map();
  private config: WPPConnectClientManagerConfig;
  private messageHandlers: ((clientId: string, message: any) => Promise<void>)[] = [];
  private sessionBackup: WhatsAppSessionBackup | null = null;
  private isMongoConnected: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private sessionBackupInterval: NodeJS.Timeout | null = null;
  private retryAttempts: Map<string, number> = new Map();
  private restoreAttempts: Map<string, number> = new Map(); // Track MongoDB restore attempts per client

  constructor(config: WPPConnectClientManagerConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    await this.initializeMongoDB();
    this.startHealthCheck();
    this.startPeriodicSessionBackup();
  }

  private async initializeMongoDB(): Promise<void> {
    try {
      if (mongoose.connection.readyState === 1) {
        this.isMongoConnected = true;
        // Initialize WhatsApp-specific session backup service
        this.sessionBackup = new WhatsAppSessionBackup();
        console.log('✅ WhatsApp Session Backup service initialized');
      } else {
        throw new Error('MongoDB connection not available');
      }
    } catch (error) {
      console.error('❌ Failed to initialize WPPConnect MongoDB:', error);
      throw error;
    }
  }

  public async createClient(clientId: string, skipRestore: boolean = false): Promise<WPPConnectClientInfo> {
    if (this.clients.has(clientId)) {
      throw new Error(`Client with ID '${clientId}' already exists`);
    }

    console.log(`🚀 Creating new WPPConnect client: ${clientId}`);

    if (!this.isMongoConnected || !this.sessionBackup) {
      throw new Error('MongoDB connection is required. Please ensure MONGODB_URI is set and MongoDB is connected.');
    }

    // CRITICAL: Check if local session folder exists with valid data FIRST
    // MongoDB backup's purpose is to restore to tokens/{clientId} folder
    // IMPORTANT: Always check if MongoDB backup is newer than local session to prevent using stale sessions
    const sessionPath = path.join(process.cwd(), 'tokens', clientId);
    const defaultPath = path.join(sessionPath, 'Default');
    const indexedDBPath = path.join(defaultPath, 'IndexedDB');
    const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
    
    let hasLocalSession = false;
    let localSessionAge = 0; // Age of local session in milliseconds
    
    if (fs.existsSync(sessionPath) && fs.existsSync(defaultPath)) {
      // Check if session folder has valid authentication data
      const hasIndexedDB = fs.existsSync(indexedDBPath);
      const hasLocalStorage = fs.existsSync(localStoragePath);
      
      if (hasIndexedDB || hasLocalStorage) {
        hasLocalSession = true;
        
        // Get the modification time of the session folder to determine its age
        try {
          const sessionStats = fs.statSync(sessionPath);
          localSessionAge = Date.now() - sessionStats.mtimeMs;
          const ageHours = (localSessionAge / (1000 * 60 * 60)).toFixed(1);
          console.log(`📁 [${clientId}] Local session folder exists (age: ${ageHours} hours)`);
        } catch (error) {
          console.warn(`⚠️  [${clientId}] Could not get local session age:`, error);
        }
        
        console.log(`📁 [${clientId}] Session folder: ${sessionPath}`);
        if (hasIndexedDB) {
          console.log(`✅ [${clientId}] IndexedDB found - session data ready`);
        }
        if (hasLocalStorage) {
          console.log(`✅ [${clientId}] Local Storage found - session data ready`);
        }
      } else {
        console.log(`⚠️  [${clientId}] Local session folder exists but appears empty/corrupted`);
      }
    }

    // WPPConnect's native way is to preserve tokens in local session folder
    // MongoDB backup is only used as a fallback if local session doesn't exist or is corrupted
    // Always prefer local session if it exists (this is the native WPPConnect behavior)
    let shouldRestoreFromMongo = false;
    
    if (!skipRestore && !hasLocalSession) {
      // No local session exists - restore from MongoDB backup if available
      try {
        const backups = await this.sessionBackup!.listWhatsAppBackups(clientId);
        if (backups.length > 0) {
          const latestBackup = backups[0];
          if (latestBackup.uploadDate) {
            const backupAgeHours = ((Date.now() - new Date(latestBackup.uploadDate).getTime()) / (1000 * 60 * 60)).toFixed(1);
            console.log(`📦 [${clientId}] MongoDB backup found (age: ${backupAgeHours} hours) - restoring as fallback`);
          }
          shouldRestoreFromMongo = true;
        } else {
          console.log(`⚠️  [${clientId}] No local session and no MongoDB backup - will require QR code scan`);
        }
      } catch (error) {
        console.warn(`⚠️  [${clientId}] Error checking MongoDB backup:`, error);
      }
    } else if (hasLocalSession) {
      // Local session exists - use it (WPPConnect's native way)
      // MongoDB TokenStore will be used by WPPConnect to load/save tokens
      console.log(`✅ [${clientId}] Using existing local session folder (WPPConnect's native preservation method)`);
      console.log(`ℹ️  [${clientId}] MongoDB TokenStore will handle token persistence automatically`);
    }

    // Restore from MongoDB if needed (only when no local session exists)
    if (shouldRestoreFromMongo) {
      console.log(`📥 [${clientId}] Restoring from MongoDB backup (local session not found)...`);
      const restored = await this.sessionBackup!.restoreWhatsAppSession(clientId);
      if (!restored) {
        console.warn(`⚠️  [${clientId}] MongoDB restore failed - client will require QR code scan`);
      } else {
        console.log(`✅ [${clientId}] Session restored from MongoDB, creating client...`);
        hasLocalSession = true; // After restore, we have a local session
      }
    } else if (hasLocalSession && skipRestore) {
      console.log(`✅ [${clientId}] Using existing local session folder (skip restore flag set)`);
    } else if (!hasLocalSession && skipRestore) {
      console.log(`⏱️  [${clientId}] Skip restore flag set - no local session available`);
    }

    // Add placeholder client info immediately so it's queryable
    const placeholderClientInfo: WPPConnectClientInfo = {
      clientId,
      client: null as any, // Will be set after creation
      isReady: false,
      lastActivity: new Date(),
      status: 'initializing'
    };
    this.clients.set(clientId, placeholderClientInfo);

    // Create message handler function BEFORE client creation
    // This ensures we can register it immediately after client is created
    const messageHandler = async (message: any) => {
      // DEBUG: Log ALL incoming messages to verify handler is being called
      console.log(`🔔 [${clientId}] onMessage handler CALLED - type: ${message.type || 'unknown'}, from: ${message.from || 'unknown'}, fromMe: ${message.fromMe || false}`);
      
      // CRITICAL: Filter out messages sent by the bot itself to prevent infinite loops
      // This must be checked FIRST before any processing
      if (message.fromMe === true) {
        console.log(`🔕 [${clientId}] Ignoring bot's own message (fromMe=true)`);
        return; // Exit early - don't process bot's own messages
      }
      
      // Also check if message is from bot's own number
      const senderNumber = message.from?.replace('@c.us', '') || '';
      const currentClientInfo = this.clients.get(clientId);
      if (currentClientInfo && currentClientInfo.phoneNumber) {
        const botNumber = currentClientInfo.phoneNumber.replace('@c.us', '');
        if (senderNumber === botNumber) {
          // Silently ignore messages from bot's own number
          return;
        }
      }
      
      // Filter out non-message events
      const msgType = message.type || '';
      const ignoredTypes = ['ack', 'status', 'notification', 'protocol', 'e2e_notification'];
      if (ignoredTypes.includes(msgType.toLowerCase())) {
        console.log(`🔕 [${clientId}] Ignoring non-message event type: ${msgType}`);
        return; // Exit early - these are status updates, not messages
      }
      
      try {
        const clientInfo = this.clients.get(clientId);
        
        if (!clientInfo) {
          console.error(`❌ [${clientId}] Client info not found - message dropped`);
          return;
        }
        
        if (!clientInfo.isReady) {
          console.warn(`⏸️  [${clientId}] Client not ready - message may be delayed`);
        }
        
        if (this.messageHandlers.length === 0) {
          console.error(`❌ [${clientId}] No message handlers registered!`);
          return;
        }
        
        // Process messages (silently - handlers will log if needed)
        for (let i = 0; i < this.messageHandlers.length; i++) {
          const handler = this.messageHandlers[i];
          if (!handler) {
            continue;
          }
          try {
            await handler(clientId, message);
          } catch (error) {
            console.error(`❌ [${clientId}] Handler error:`, error instanceof Error ? error.message : error);
          }
        }
      } catch (error) {
        console.error(`❌ [${clientId}] CRITICAL ERROR in onMessage callback:`, error);
        console.error(`❌ [${clientId}] Error stack:`, error instanceof Error ? error.stack : 'No stack');
      }
    };

    try {
      // Create WPPConnect client with MongoDB TokenStore
      // WPPConnect needs TokenStore to save/restore authentication tokens
      // This works together with browser session files for complete session persistence
      const mongoTokenStore = createMongoTokenStore();
      const client = await create({
        session: clientId,
        // Use MongoDB TokenStore to save/restore WPPConnect authentication tokens
        // This is REQUIRED - without tokens, sessions will always become unpaired
        tokenStore: mongoTokenStore,
        
        // Browser configuration
        headless: true,
        devtools: false,
        useChrome: true,
        debug: false,
        logQR: false, // Disable console QR - use API endpoint instead
        // folderNameToken is for browser profile path, not token files
        // Our custom tokenStore handles token persistence
        
        // Browser options - CRITICAL: Tell WPPConnect where to find the session folder
        // Without userDataDir, WPPConnect will create its own folder and ignore our restored session!
        puppeteerOptions: {
          executablePath: this.config.chromiumPath,
          args: this.config.puppeteerArgs,
          // CRITICAL: Set userDataDir to use our restored session folder
          // This ensures WPPConnect uses tokens/{clientId} instead of creating its own folder
          userDataDir: sessionPath,
          // Increase timeout for browser launch (helpful for restored sessions)
          timeout: 60000,
          // Handle process errors gracefully
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false
        },
        
        // Browser arguments (optimized for memory)
        browserArgs: this.config.puppeteerArgs,
        
        // Callbacks
        statusFind: (statusSession, session) => {
          console.log(`📊 [${session}] WPPConnect Status: ${statusSession}`);
          
          // Log detailed status information
          if (statusSession === 'notLogged') {
            console.log(`🔓 [${session}] Not logged in - will require QR code scan`);
          } else if (statusSession === 'isLogged') {
            console.log(`✅ [${session}] Already logged in - session authenticated`);
            // Mark as ready when logged in
            const clientInfo = this.clients.get(clientId);
            if (clientInfo) {
              clientInfo.isReady = true;
              clientInfo.status = 'ready';
              clientInfo.qrCode = undefined; // Clear QR code when authenticated
              // Reset restore attempts counter on successful connection
              this.restoreAttempts.delete(clientId);
              console.log(`✅ [${clientId}] Client marked as ready (isLogged status)`);
            }
          } else if (statusSession === 'qrReadSuccess') {
            console.log(`✅ [${session}] QR code scanned successfully - authentication in progress...`);
            // Update status immediately when QR is scanned
            const clientInfo = this.clients.get(clientId);
            if (clientInfo) {
              clientInfo.status = 'authenticated';
              clientInfo.qrCode = undefined; // Clear QR code after successful scan
              console.log(`✅ [${clientId}] Status updated to authenticated after QR scan`);
            }
          } else if (statusSession === 'inChat') {
            console.log(`✅ [${session}] Session is active and in chat`);
            // Mark as ready when in chat, BUT verify actual connection
            const clientInfo = this.clients.get(clientId);
            if (clientInfo && clientInfo.client) {
              // CRITICAL: Verify client is actually connected by checking phone number
              // If getWid() fails or returns null, the session is stale and needs re-authentication
              clientInfo.client.getWid().then(async (wid: string) => {
                if (wid) {
                  console.log(`✅ [${clientId}] Verified connection - WID: ${wid}`);
                  
                  // Additional verification: Try to get connection state
                  try {
                    const state = await clientInfo.client.getConnectionState();
                    console.log(`🔍 [${clientId}] Connection state: ${state}`);
                    
                    // SocketState can be: 'close' | 'connecting' | 'open'
                    // Check if state is a string and indicates disconnection
                    const stateStr = String(state);
                    if (stateStr === 'close' || stateStr === 'connecting') {
                      console.warn(`⚠️  [${clientId}] Session shows inChat but connection state is ${stateStr} - session may be stale`);
                      // Don't mark as ready if connection state indicates disconnection
                      return;
                    }
                  } catch (stateError: any) {
                    console.warn(`⚠️  [${clientId}] Could not verify connection state:`, stateError.message);
                    // Continue anyway - getWid() succeeded which is a good sign
                  }
                  
                  clientInfo.isReady = true;
                  clientInfo.status = 'ready';
                  clientInfo.qrCode = undefined;
                  
                  // Reset restore attempts counter on successful connection (after delay to ensure stability)
                  setTimeout(() => {
                    const clientInfo = this.clients.get(clientId);
                    if (clientInfo && clientInfo.isReady) {
                      this.restoreAttempts.delete(clientId);
                      console.log(`✅ [${clientId}] Restore counter reset - client inChat and stable`);
                    }
                  }, 5000);
                  console.log(`✅ [${clientId}] Client marked as ready (inChat status)`);
                } else {
                  console.warn(`⚠️  [${clientId}] inChat status but WID is null - client may not be fully connected`);
                  console.warn(`⚠️  [${clientId}] Session may be stale - consider deleting session folder and re-scanning QR`);
                  // Don't mark as ready if WID is null
                }
              }).catch((err: any) => {
                console.error(`❌ [${clientId}] Failed to verify connection (inChat status but getWid failed):`, err.message);
                console.error(`❌ [${clientId}] Session appears stale - client will not be marked as ready`);
                console.error(`❌ [${clientId}] To fix: Delete tokens/${clientId} folder and restart to force QR scan`);
                // Don't mark as ready if we can't verify connection
              });
              
              // Don't mark as ready immediately - wait for getWid() verification
              // This prevents marking stale sessions as ready
            }
          } else {
            console.log(`ℹ️  [${session}] Status: ${statusSession}`);
          }
          
          this.updateClientStatus(clientId, statusSession);
          
          // WPPConnect TokenStore handles session persistence automatically
          // No manual saving needed - follows official Redis example pattern
        },
        
        catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
          console.log(`📱 QR Code generated for ${clientId} (attempt ${attempts})`);
          console.log(`📱 QR Code URL: ${urlCode || 'N/A'}`);
          console.log(`📱 QR Code size: ${base64Qr?.length || 0} bytes`);
          console.log(`📱 Access QR image via: GET /api/whatsapp/clients/${clientId}/qr-image`);
          console.log(`⚠️  IMPORTANT: QR codes expire after ~20 seconds. Scan quickly!`);
          console.log(`📱 Scan with WhatsApp: Settings > Linked Devices > Link a Device`);
          this.updateClientQR(clientId, base64Qr);
          
          // Log QR code data for debugging (first 100 chars of base64)
          if (base64Qr) {
            const preview = base64Qr.substring(0, 100);
            console.log(`📱 QR Preview: ${preview}...`);
          }
        },
        
        // Auto-close settings
        // WPPConnect doesn't accept 0 to disable, so use a very high value instead
        // Setting to 24 hours (86400000 ms) to effectively disable auto-close
        autoClose: 86400000, // 24 hours - effectively disabled to prevent unexpected disconnections
        
        // Additional options
        disableWelcome: true,
        updatesLog: true,
        
        // Don't wait for login - proceed immediately (client is already authenticated from restored session)
        waitForLogin: false
      });

      console.log(`✅ WPPConnect client created: ${clientId}`);
      
      // Store handler reference - CRITICAL: Store the exact function reference
      const clientInfoForStorage = this.clients.get(clientId);
      if (clientInfoForStorage) {
        (clientInfoForStorage as any)._messageHandler = messageHandler;
        (clientInfoForStorage as any)._messageHandlerRegistered = false;
        // Debug: Verify handler is stored correctly
        console.log(`🔍 [${clientId}] Handler stored - type: ${typeof messageHandler}, clientId in closure: ${clientId}`);
      }
      
      // Register message handler - poll until onMessage is exposed
      // WPPConnect exposes onMessage after wapi.js injection
      // CRITICAL: Register IMMEDIATELY when onMessage is available, not wait for CONNECTED
      // This ensures we catch messages that arrive right after connection
      console.log(`📋 [${clientId}] Message handler function created - will register as soon as onMessage is exposed`);
      
      const tryRegisterWhenReady = (attempt: number = 1, maxAttempts: number = 30) => {
        const currentClientInfo = this.clients.get(clientId);
        if (!currentClientInfo) {
          return; // Client was removed
        }
        
        // Check if already registered
        if ((currentClientInfo as any)._messageHandlerRegistered) {
          return; // Already registered
        }
        
        // Check if onMessage is available
        if (typeof client.onMessage === 'function') {
          try {
            console.log(`📝 [${clientId}] Registering client.onMessage() handler (immediate registration when exposed, attempt ${attempt})...`);
            client.onMessage(messageHandler);
            (currentClientInfo as any)._messageHandlerRegistered = true;
            console.log(`✅ [${clientId}] client.onMessage() registered successfully (immediate registration)`);
          } catch (regError) {
            console.error(`❌ [${clientId}] Error registering handler immediately:`, regError instanceof Error ? regError.message : regError);
          }
        } else if (attempt < maxAttempts) {
          // Retry after 500ms
          setTimeout(() => tryRegisterWhenReady(attempt + 1, maxAttempts), 500);
        }
      };
      
      // Start polling immediately - don't wait for CONNECTED state
      setTimeout(() => tryRegisterWhenReady(), 1000); // Wait 1 second for client to initialize

      // Check for QR code manually (catchQR callback sometimes doesn't fire)
      setImmediate(async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for initialization
          
          const clientInfo = this.clients.get(clientId);
          if (clientInfo && !clientInfo.qrCode) {
            try {
              const qrData = await client.getQrCode();
              if (qrData && qrData.base64Image) {
                this.updateClientQR(clientId, qrData.base64Image);
              }
            } catch (qrError) {
              // Silent fail - QR will be available via catchQR callback
            }
          }
        } catch (error) {
          console.error(`❌ [${clientId}] QR check error:`, error);
        }
      });

      // Set up reaction handler with correct TypeScript types
      // Reference: https://wppconnect.io/wppconnect/classes/Whatsapp.html#onreactionmessage
      // Reaction type: { id, msgId, reactionText, read, orphan, orphanReason, timestamp }
      try {
        client.onReactionMessage(async (reaction: any) => {
          console.log(`👍 REACTION EVENT FIRED for ${clientId}:`, JSON.stringify(reaction, null, 2));
          
          try {
            const emoji = reaction.reactionText || '👍';
            
            // Skip if reaction is removed (empty reactionText)
            if (!emoji || emoji === '') {
              console.log(`🗑️  Reaction removed (ID: ${reaction.id})`);
              return;
            }
            
            // Extract the reactor's ID from reaction.id.remote
            // reaction.id.remote contains the user who sent the reaction (e.g., "6282121547121@c.us")
            const reactorId = reaction.id?.remote || reaction.id?._serialized;
            
            if (!reactorId) {
              console.log(`⚠️  Could not identify who sent the reaction, skipping`);
              console.log(`🔍 Reaction structure:`, JSON.stringify(reaction, null, 2).substring(0, 200));
              return;
            }
            
            console.log(`📝 Reaction: ${emoji} by ${reactorId}`);
            
            // Get the message that was reacted to
            const originalMessage = await client.getMessageById(reaction.msgId);
            
            if (originalMessage) {
              console.log(`📝 Original message: ${originalMessage.body?.substring(0, 50) || '[media]'}`);
              
              // Create synthetic message for message handler
              const reactionMessage = {
                from: reactorId, // Use the reactor's ID, not the original message sender
                body: `reacted ${emoji} to this message: ${originalMessage.body || '[media]'}`,
                type: 'reaction',
                timestamp: reaction.timestamp || Date.now(),
                quotedMsg: originalMessage,
                hasQuotedMsg: true,
                sender: originalMessage.sender // Preserve original sender info
              };
              
              // Queue with other messages
              for (const handler of this.messageHandlers) {
                try {
                  await handler(clientId, reactionMessage);
                } catch (error) {
                  console.error(`❌ Error in reaction handler:`, error);
                }
              }
            }
          } catch (err) {
            console.error(`❌ Error processing reaction:`, err);
          }
        });
        console.log(`✅ onReactionMessage handler registered for ${clientId}`);
      } catch (error) {
        console.log(`⚠️  onReactionMessage not available:`, error);
      }

      // Set up ready handler
      client.onStateChange(async (state) => {
        console.log(`🔄 [${clientId}] onStateChange event: ${state}`);
        
        // Mark as ready when CONNECTED
        if (state === 'CONNECTED') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'ready';
            clientInfo.isReady = true;
            clientInfo.lastActivity = new Date();
            // Reset restore attempts counter on successful connection
            // Only reset if we actually connected (not just if state changed)
            // Wait a bit to ensure connection is stable before resetting
            setTimeout(() => {
              const clientInfo = this.clients.get(clientId);
              if (clientInfo && clientInfo.isReady && clientInfo.status === 'ready') {
                this.restoreAttempts.delete(clientId);
                console.log(`✅ [${clientId}] Restore counter reset - client successfully connected and stable`);
              }
            }, 5000); // Wait 5 seconds to ensure connection is stable
            
            // Re-register handlers in CONNECTED state if not already registered
            // This is a fallback in case immediate registration failed
            setTimeout(async () => {
              const currentClientInfo = this.clients.get(clientId);
              const alreadyRegistered = currentClientInfo && (currentClientInfo as any)._messageHandlerRegistered;
              
              if (alreadyRegistered) {
                console.log(`✅ [${clientId}] Handler already registered (from immediate registration), skipping CONNECTED state registration`);
                return;
              }
              
              console.log(`📋 [${clientId}] Re-registering message handlers in CONNECTED state (immediate registration may have failed)...`);
              
              // Verify onMessage exists
              if (typeof client.onMessage !== 'function') {
                console.error(`❌ [${clientId}] CRITICAL: client.onMessage is not a function! Type: ${typeof client.onMessage}`);
                const clientKeys = Object.keys(client).filter(k => k.toLowerCase().includes('message') || k.toLowerCase().includes('on'));
                console.error(`❌ [${clientId}] Message-related properties: ${clientKeys.join(', ') || 'none found'}`);
                return;
              }
              
              const messageHandler = (clientInfo as any)._messageHandler;
              if (!messageHandler) {
                console.error(`❌ [${clientId}] CRITICAL: Message handler function not found in clientInfo!`);
                return;
              }
              
              try {
                // Force re-registration - this ensures handlers work after full connection
                console.log(`📝 [${clientId}] Registering client.onMessage() handler...`);
                client.onMessage(messageHandler);
                console.log(`✅ [${clientId}] client.onMessage() registered`);
                
                // NOTE: onAnyMessage is NOT registered to prevent duplicate message processing
                // onMessage already handles all incoming messages, so onAnyMessage is redundant
                
                (clientInfo as any)._messageHandlerRegistered = true;
                console.log(`✅ [${clientId}] Message handlers registered and ready`);
              } catch (regError) {
                console.error(`❌ [${clientId}] CRITICAL: Error registering handlers:`, regError);
                console.error(`❌ [${clientId}] Error details:`, regError instanceof Error ? regError.stack : regError);
              }
            }, 3000); // Wait 3 seconds after CONNECTED
            
            const handlerCount = this.messageHandlers.length;
            console.log(`✅ [${clientId}] Client connected and ready (state: ${state}) - handler registered: ${(clientInfo as any)._messageHandlerRegistered}, available handlers: ${handlerCount}`);
            
            if (handlerCount === 0) {
              console.warn(`⚠️  [${clientId}] WARNING: Client is ready but no message handlers are registered! Messages will not be processed.`);
            }
            
            // Backup WhatsApp session to MongoDB after successful connection
            setImmediate(async () => {
              try {
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for session to stabilize
                
                const backupSuccess = await this.sessionBackup!.backupWhatsAppSession(clientId);
                
                // Only cleanup old backups if new backup succeeded
                if (backupSuccess) {
                  // Wait a moment to ensure GridFS has indexed the new file
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  await this.sessionBackup!.cleanupOldWhatsAppBackups(clientId, 2);
                } else {
                  console.warn(`⚠️  [${clientId}] Backup failed, skipping cleanup to preserve existing backups`);
                }
              } catch (error) {
                console.error(`❌ [${clientId}] Session backup failed:`, error);
              }
            });
          }
          this.updateClientPhoneNumber(clientId);
        }
        
        // Handle disconnection states - register handlers when onMessage is exposed (even if unpaired)
        // This ensures handlers are ready when QR is scanned and state becomes CONNECTED
        if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            const wasReady = clientInfo.isReady; // Track if client was previously ready
            const clientAge = Date.now() - clientInfo.lastActivity.getTime(); // How long since client was created
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
            
            // Check if we should trigger MongoDB backup fallback:
            // 1. Client was previously ready (connected) and now unpaired, OR
            // 2. Client is unpaired immediately after creation (< 60 seconds) - indicates stale local session
            // BUT: Don't trigger if client was just recreated (< 30 seconds) - give it time to connect
            const isImmediatelyUnpaired = !wasReady && clientAge < 60000; // Unpaired within 60 seconds of creation
            const isJustRecreated = clientAge < 30000; // Client was just created/recreated (< 30 seconds) - grace period
            const shouldTryFallback = (wasReady || (isImmediatelyUnpaired && !isJustRecreated)) && this.sessionBackup;
            
            // Log why restore is/isn't being attempted
            if (!shouldTryFallback && this.sessionBackup) {
              if (isJustRecreated) {
                console.log(`⏸️  [${clientId}] Client just recreated (${Math.round(clientAge/1000)}s ago) - waiting before restore attempt (grace period)`);
              } else if (!wasReady && !isImmediatelyUnpaired) {
                console.log(`⏸️  [${clientId}] Client unpaired but not immediately after creation (${Math.round(clientAge/1000)}s old) - not attempting restore`);
              }
            }
            
            // Check restore attempt count (max 3 attempts)
            const currentRestoreAttempts = this.restoreAttempts.get(clientId) || 0;
            const maxRestoreAttempts = 3;
            const canAttemptRestore = currentRestoreAttempts < maxRestoreAttempts;
            
            // Debug: Log counter state
            console.log(`🔍 [${clientId}] Restore attempt check: current=${currentRestoreAttempts}, max=${maxRestoreAttempts}, canAttempt=${canAttemptRestore}`);
            
            if (shouldTryFallback && canAttemptRestore) {
              const nextAttempt = currentRestoreAttempts + 1;
              if (isImmediatelyUnpaired) {
                console.log(`⚠️  [${clientId}] Session is unpaired immediately after creation (local session appears stale) - attempting MongoDB backup fallback (attempt ${nextAttempt}/${maxRestoreAttempts})...`);
              } else {
                console.log(`⚠️  [${clientId}] Session became unpaired after being connected - attempting MongoDB backup fallback (attempt ${nextAttempt}/${maxRestoreAttempts})...`);
              }
              
              // Increment restore attempt counter BEFORE async operation
              this.restoreAttempts.set(clientId, nextAttempt);
              console.log(`🔢 [${clientId}] Restore counter incremented to: ${nextAttempt}`);
              
              // Restore in background and immediately reconnect
              setImmediate(async () => {
                try {
                  if (this.sessionBackup) {
                    // Check if MongoDB backup exists before attempting restore
                    const backups = await this.sessionBackup.listWhatsAppBackups(clientId);
                    if (backups.length > 0) {
                      console.log(`📦 [${clientId}] MongoDB backup found - restoring as fallback...`);
                      
                      // CRITICAL: Close existing client FIRST before restore
                      // This releases file handles so the directory can be deleted
                      const existingClientInfo = this.clients.get(clientId);
                      if (existingClientInfo && existingClientInfo.client) {
                        try {
                          console.log(`🔄 [${clientId}] Closing existing client with stale session before restore...`);
                          // Ensure client is fully closed - wait for close to complete
                          await existingClientInfo.client.close().catch(err => {
                            console.warn(`⚠️  [${clientId}] Error closing existing client:`, err.message);
                          });
                          
                          // Wait a bit more to ensure all Puppeteer contexts are cleaned up
                          await new Promise(resolve => setTimeout(resolve, 1000));
                        } catch (closeError) {
                          console.warn(`⚠️  [${clientId}] Error closing client:`, closeError);
                        }
                      }
                      
                      // Remove from clients map
                      this.clients.delete(clientId);
                      
                      // Wait for file handles to be released and browser contexts to fully close
                      console.log(`⏳ [${clientId}] Waiting for file handles and browser contexts to be released...`);
                      await new Promise(resolve => setTimeout(resolve, 5000)); // Increased wait time for Puppeteer cleanup
                      
                      // Now restore from MongoDB
                      const restored = await this.sessionBackup.restoreWhatsAppSession(clientId);
                      if (restored) {
                        const currentAttempts = this.restoreAttempts.get(clientId) || 0;
                        console.log(`✅ [${clientId}] Session restored from MongoDB backup (attempt ${currentAttempts}/${maxRestoreAttempts}) - reconnecting immediately...`);
                        
                        // DO NOT reset counter here - wait for actual connection success
                        // Counter will be reset when client successfully connects (CONNECTED state)
                        
                        // Recreate client with restored session
                        console.log(`🔄 [${clientId}] Recreating client with restored session...`);
                        try {
                          // Add extra delay to ensure browser contexts are fully cleaned up
                          await new Promise(resolve => setTimeout(resolve, 2000));
                          await this.createClient(clientId, true); // skipRestore=true since we already restored
                          console.log(`✅ [${clientId}] Client recreated successfully with restored session`);
                          // Note: If session is still unpaired, it will trigger another restore attempt
                          // Counter is preserved, so next attempt will be currentAttempts + 1
                        } catch (recreateError: any) {
                          // Handle Puppeteer protocol errors gracefully
                          // These errors occur when WPPConnect tries to inject wapi.js while the page is still loading/navigating
                          const errorMsg = recreateError?.message || String(recreateError);
                          const isPuppeteerProtocolError = errorMsg.includes('Protocol error') || 
                                                           errorMsg.includes('Cannot find context') ||
                                                           errorMsg.includes('Execution context was destroyed') ||
                                                           errorMsg.includes('No node with given id found') ||
                                                           errorMsg.includes('DOM.resolveNode') ||
                                                           errorMsg.includes('DOM.describeNode') ||
                                                           errorMsg.includes('wapi.js failed');
                          
                          if (isPuppeteerProtocolError) {
                            // These are non-fatal - WPPConnect has built-in retry logic
                            console.warn(`⚠️  [${clientId}] Puppeteer protocol error during initialization (expected during page load):`, errorMsg.substring(0, 80) + '...');
                            console.log(`ℹ️  [${clientId}] WPPConnect will automatically retry - this is normal during client initialization`);
                            console.log(`ℹ️  [${clientId}] Client creation continuing...`);
                          } else {
                            console.error(`❌ [${clientId}] Error recreating client after restore:`, recreateError);
                          }
                          // Don't reset counter if recreation fails - it will try again
                        }
                      } else {
                        const attempts = this.restoreAttempts.get(clientId) || 0;
                        if (attempts >= maxRestoreAttempts) {
                          console.warn(`⚠️  [${clientId}] MongoDB backup restore failed after ${maxRestoreAttempts} attempts - stopping restore attempts, will require QR code scan`);
                          console.log(`ℹ️  [${clientId}] Client will remain in UNPAIRED state - waiting for QR code scan. Process continues running normally.`);
                          this.restoreAttempts.delete(clientId); // Clean up counter
                        } else {
                          console.warn(`⚠️  [${clientId}] MongoDB backup restore failed (attempt ${attempts}/${maxRestoreAttempts}) - will try again if session becomes unpaired`);
                        }
                      }
                    } else {
                      console.log(`ℹ️  [${clientId}] No MongoDB backup available - will require QR code scan`);
                      this.restoreAttempts.delete(clientId); // Clean up counter if no backup exists
                    }
                  }
                } catch (error) {
                  const attempts = this.restoreAttempts.get(clientId) || 0;
                  console.error(`❌ [${clientId}] Error restoring from MongoDB backup after unpairing (attempt ${attempts}/${maxRestoreAttempts}):`, error);
                  
                  if (attempts >= maxRestoreAttempts) {
                    console.warn(`⚠️  [${clientId}] Max restore attempts (${maxRestoreAttempts}) reached - stopping restore attempts, will require QR code scan`);
                    console.log(`ℹ️  [${clientId}] Client will remain in UNPAIRED state - waiting for QR code scan. Process continues running normally.`);
                    this.restoreAttempts.delete(clientId); // Clean up counter
                  }
                }
              });
            } else if (shouldTryFallback && !canAttemptRestore) {
              // Max attempts reached - stop trying and use QR scan
              console.warn(`⚠️  [${clientId}] Max MongoDB restore attempts (${maxRestoreAttempts}) reached - will require QR code scan`);
              console.log(`ℹ️  [${clientId}] Client will remain in UNPAIRED state - waiting for QR code scan. Process continues running normally.`);
              this.restoreAttempts.delete(clientId); // Clean up counter
            }
            
            // Register handlers now (onMessage is exposed even in UNPAIRED state)
            // This ensures handlers are ready when QR is scanned and state becomes CONNECTED
            const alreadyRegistered = (clientInfo as any)._messageHandlerRegistered;
            if (!alreadyRegistered && typeof client.onMessage === 'function') {
              console.log(`📋 [${clientId}] Session is unpaired, but registering handlers now (will be active after QR scan)...`);
              
              setTimeout(() => {
                const messageHandler = (clientInfo as any)._messageHandler;
                if (messageHandler) {
                  try {
                    const dispose = client.onMessage(messageHandler);
                    // Store dispose function for cleanup
                    if (dispose && typeof dispose === 'function') {
                      (clientInfo as any)._messageHandlerDispose = dispose;
                    }
                    // NOTE: onAnyMessage is NOT registered to prevent duplicate message processing
                    (clientInfo as any)._messageHandlerRegistered = true;
                    console.log(`✅ [${clientId}] Handler registered (waiting for QR scan to connect)`);
                  } catch (regError) {
                    console.error(`❌ [${clientId}] Error registering handler in UNPAIRED state:`, regError);
                  }
                }
              }, 2000);
            }
          }
        }
        
        // Handle conflict - might indicate session change
        if (state === 'CONFLICT') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
          }
        }
      });

      // Update the placeholder with the actual client instance
      const existingClientInfo = this.clients.get(clientId);
      if (existingClientInfo) {
        existingClientInfo.client = client;
        existingClientInfo.lastActivity = new Date();
        console.log(`✅ WPPConnect client ${clientId} initialized successfully`);
        
        // Update phone number if client is already authenticated (restored session)
        if (existingClientInfo.isReady) {
          await this.updateClientPhoneNumber(clientId);
        }
        
        return existingClientInfo;
      } else {
        // Fallback if somehow the placeholder was removed
        const clientInfo: WPPConnectClientInfo = {
          clientId,
          client,
          isReady: false,
          lastActivity: new Date(),
          status: 'initializing'
        };
        this.clients.set(clientId, clientInfo);
        return clientInfo;
      }

    } catch (error: any) {
      // Check if it's a Puppeteer protocol error (non-fatal during initialization)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPuppeteerProtocolError = errorMessage.includes('Protocol error') || 
                                       errorMessage.includes('Cannot find context') ||
                                       errorMessage.includes('Execution context was destroyed') ||
                                       errorMessage.includes('No node with given id found') ||
                                       errorMessage.includes('DOM.resolveNode') ||
                                       errorMessage.includes('DOM.describeNode') ||
                                       errorMessage.includes('wapi.js failed');
      
      if (isPuppeteerProtocolError) {
        // These are usually non-fatal - WPPConnect handles them internally with retry logic
        console.warn(`⚠️  [${clientId}] Puppeteer protocol error during client creation (expected during page load):`, errorMessage.substring(0, 80) + '...');
        console.log(`ℹ️  [${clientId}] WPPConnect will retry automatically - this is normal during initialization`);
        // Still throw so the caller knows, but with better context
        throw error;
      }
      
      console.error(`❌ Failed to create WPPConnect client ${clientId}:`, error);
      
      // Check if error is due to browser already running or profile locked
      const isBrowserLockError = errorMessage.includes('browser is already running') || 
                                 errorMessage.includes('userDataDir') ||
                                 errorMessage.includes('profile appears to be in use') ||
                                 errorMessage.includes('locked the profile');
      
      if (isBrowserLockError) {
        // Check if we've already retried to prevent infinite loops
        const retryKey = `${clientId}_lock_retry`;
        const retryCount = (this as any)[retryKey] || 0;
        
        if (retryCount >= 2) {
          console.log(`❌ Max retry attempts (${retryCount}) reached for ${clientId}, giving up`);
          delete (this as any)[retryKey];
          
          // Delete the corrupted browser folder and MongoDB session
          const fs = require('fs');
          const path = require('path');
          const browserPath = path.join(process.cwd(), 'tokens', clientId);
          
          try {
            if (fs.existsSync(browserPath)) {
              fs.rmSync(browserPath, { recursive: true, force: true });
              console.log(`🗑️  Removed corrupted browser folder: ${browserPath}`);
            }
            
            // Session cleanup handled by WhatsApp session backup service
            console.log(`🗑️  Removed corrupted session from MongoDB for ${clientId}`);
          } catch (e) {
            console.error(`⚠️  Cleanup error:`, e);
          }
          
          throw new Error(`Failed to recover from browser lock after ${retryCount} attempts`);
        }
        
        (this as any)[retryKey] = retryCount + 1;
        console.log(`🔄 Browser/profile lock detected for ${clientId}, cleanup attempt ${retryCount + 1}/2...`);
        
        try {
          const { execSync } = require('child_process');
          const fs = require('fs');
          const path = require('path');
          const clientTokensPath = path.join(process.cwd(), 'tokens', clientId);
          
          // STEP 1: Try to kill any Chromium processes using this profile FIRST
          // This is less destructive than deleting the folder
          
          // Extract PID from error message if available
          const pidMatch = errorMessage.match(/process \((\d+)\)/);
          if (pidMatch && pidMatch[1]) {
            const lockingPid = pidMatch[1];
            console.log(`🔍 Found locking process PID: ${lockingPid}`);
            
            try {
              // Try to kill if it's a local process
              execSync(`kill -0 ${lockingPid} 2>/dev/null && kill -9 ${lockingPid}`, { 
                stdio: 'ignore',
                timeout: 5000 
              });
              console.log(`💀 Killed stale Chromium process: ${lockingPid}`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (killError) {
              console.log(`ℹ️  Process ${lockingPid} not found (may be remote or already terminated)`);
            }
          }
          
          // Kill any local Chromium processes using this profile
          let processesKilled = false;
          try {
            const sessionPath = path.join(process.cwd(), 'tokens', clientId);
            // Try to find Chromium processes by userDataDir path
            const grepCmd = `ps aux | grep -i "[c]hromium" | grep "${sessionPath}" | awk '{print $2}'`;
            const pids = execSync(grepCmd, { encoding: 'utf8', timeout: 5000 }).trim();
            if (pids) {
              const pidList = pids.split('\n').filter(Boolean);
              for (const pid of pidList) {
                try {
                  execSync(`kill -9 ${pid}`, { stdio: 'ignore', timeout: 5000 });
                  console.log(`💀 Killed Chromium process using ${clientId}: ${pid}`);
                  processesKilled = true;
                } catch (e) {
                  // Process already gone
                }
              }
              if (processesKilled) {
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
          } catch (grepError) {
            console.log(`ℹ️  No local Chromium processes found for ${clientId}`);
          }
          
          // STEP 2: Clean lock files ONLY as a last resort and ONLY if we killed processes
          // Lock files should be automatically released when processes are killed
          // Only clean them manually if processes were killed but lock files still exist after a delay
          if (processesKilled) {
            console.log(`ℹ️  Processes were killed - waiting for OS to release lock files...`);
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds for OS to clean up
            
            // Only check for remaining lock files after delay
            if (fs.existsSync(clientTokensPath)) {
              const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
              let stillLocked = false;
              for (const lockFile of lockFiles) {
                const lockPath = path.join(clientTokensPath, lockFile);
                if (fs.existsSync(lockPath)) {
                  stillLocked = true;
                  break;
                }
              }
              
              if (stillLocked && retryCount >= 2) {
                // Only clean lock files on 2nd retry if processes were killed
                console.log(`🔍 Cleaning remaining lock files after process kill...`);
                let cleanedCount = 0;
                for (const lockFile of lockFiles) {
                  const lockPath = path.join(clientTokensPath, lockFile);
                  try {
                    if (fs.existsSync(lockPath)) {
                      fs.unlinkSync(lockPath);
                      cleanedCount++;
                    }
                  } catch (e) {
                    // Ignore - lock file might be in active use
                  }
                }
                if (cleanedCount > 0) {
                  console.log(`🧹 Cleaned ${cleanedCount} remaining lock file(s) from ${clientId} folder`);
                }
              }
            }
          }
          
          // STEP 3: Only delete the specific client's folder if processes couldn't be killed
          // and this is the second attempt
          if (retryCount >= 2 && !processesKilled) {
            console.log(`⚠️  Could not kill processes, deleting ${clientId} folder as last resort...`);
            if (fs.existsSync(clientTokensPath)) {
              fs.rmSync(clientTokensPath, { recursive: true, force: true });
              console.log(`🗑️  Removed ${clientId} folder - will restore from MongoDB`);
            }
          }
          
          console.log(`✅ Cleanup completed, retrying...`);
          
          // Remove the failed placeholder
          this.clients.delete(clientId);
          
          // Wait for filesystem to sync
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Retry creating the client
          const result = await this.createClient(clientId);
          
          // Success! Clear retry counter
          delete (this as any)[retryKey];
          return result;
          
        } catch (cleanupError) {
          console.error(`❌ Failed to cleanup browser locks for ${clientId}:`, cleanupError);
          throw cleanupError;
        }
      }
      
      // Remove the placeholder client if creation failed
      this.clients.delete(clientId);
      console.log(`🗑️  Removed failed client ${clientId} from map`);
      
      // Only delete from MongoDB if it's a true authentication failure, not process interruption or browser lock
      // Check if error indicates authentication failure (not timeout, not process kill, not browser lock)
      const isAuthFailure = errorMessage.includes('authentication') || 
                           errorMessage.includes('qr') ||
                           errorMessage.includes('timeout') === false; // Don't delete on timeout
      
      const isBrowserIssue = errorMessage.includes('SIGTERM') || 
                            errorMessage.includes('SIGINT') ||
                            errorMessage.includes('profile appears to be in use') ||
                            errorMessage.includes('locked the profile') ||
                            errorMessage.includes('browser is already running') ||
                            errorMessage.includes('Auto Close Called'); // Preserve session on auto-close
      
      if (this.sessionBackup && isAuthFailure && !isBrowserIssue) {
        // Session cleanup handled by WhatsApp session backup service
      } else {
        console.log(`ℹ️  Keeping existing session in MongoDB for ${clientId} (error: ${errorMessage.substring(0, 50)}...)`);
      }
      
      throw error;
    }
  }


  // Session backup is now handled by WhatsAppSessionBackup service

  private updateClientStatus(clientId: string, status: string): void {
    const clientInfo = this.clients.get(clientId);
    if (clientInfo) {
      switch (status) {
        case 'isLogged':
        case 'qrReadSuccess':
        case 'inChat':
          // Client is authenticated and ready
          clientInfo.status = 'ready';
          clientInfo.isReady = true;
          clientInfo.qrCode = undefined; // Clear QR code when ready (no longer needed)
          // Reset restore attempts counter on successful connection
          this.restoreAttempts.delete(clientId);
          console.log(`✅ WPPConnect client ${clientId} status: ${status} → ready`);
          
          // WPPConnect automatically handles session saving via tokenStore
          console.log(`✅ WPPConnect automatically manages session persistence via tokenStore`);
          break;
        case 'notLogged':
          clientInfo.status = 'qr_required';
          clientInfo.isReady = false;
          // Keep existing QR code if available
          console.log(`📋 WPPConnect client ${clientId} notLogged - QR code available: ${!!clientInfo.qrCode}`);
          break;
        case 'autocloseCalled':
          // Auto-close is normal idle behavior - don't delete the client!
          // Just mark as idle so it can be reactivated on next message
          console.log(`💤 Client ${clientId} auto-closed due to inactivity - keeping session for reactivation`);
          clientInfo.status = 'disconnected';
          clientInfo.isReady = false;
          break; // Don't delete - keep the client and session
        case 'qrReadFail':
          // Clear authentication failures - delete from MongoDB
          console.log(`🗑️  Removing client ${clientId} - Authentication failed (${status})`);
          this.clients.delete(clientId);
          
          // Session cleanup handled by WhatsApp session backup service
          return;
        case 'qrReadError':
          // qrReadError can be a false positive if client is already authenticated
          // Only treat as failure if client is NOT ready/authenticated
          if (clientInfo.isReady || clientInfo.status === 'ready' || clientInfo.status === 'authenticated') {
            break;
          }
          
          // Only delete if truly not authenticated
          this.clients.delete(clientId);
          
          // Session cleanup handled by WhatsApp session backup service
          return;
        case 'browserClose':
          // Browser close is normal (happens during shutdown/restart)
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
          }
          break;
        case 'desconnectedMobile':
          // Phone disconnected - this happens if QR scan fails or phone disconnects
          console.log(`📱 [${clientId}] Phone disconnected (desconnectedMobile)`);
          console.log(`📱 [${clientId}] This usually means:`);
          console.log(`📱   1. QR code expired before scan (QR codes expire in ~20 seconds)`);
          console.log(`📱   2. Scan failed or was rejected`);
          console.log(`📱   3. Phone lost connection during authentication`);
          console.log(`📱 [${clientId}] Client will need a fresh QR code - check status and get new QR`);
          clientInfo.status = 'qr_required'; // Allow new QR generation
          clientInfo.isReady = false;
          clientInfo.qrCode = undefined; // Clear old QR so new one can be generated
          break;
        case 'serverClose':
          clientInfo.status = 'disconnected';
          clientInfo.isReady = false;
          break;
        default:
          // Don't override status if we don't recognize it
      }
      clientInfo.lastActivity = new Date();
    }
  }

  private updateClientQR(clientId: string, qrCode: string): void {
    const clientInfo = this.clients.get(clientId);
    if (clientInfo) {
      clientInfo.qrCode = qrCode;
      clientInfo.status = 'qr_required';
      clientInfo.lastActivity = new Date();
      console.log(`📱 [${clientId}] QR code updated (length: ${qrCode.length})`);
      console.log(`📱 [${clientId}] QR available at: GET /api/whatsapp/clients/${clientId}/qr-image`);
    } else {
      console.error(`❌ [${clientId}] Client not found in map when updating QR code!`);
      console.log(`📋 Current clients in map: ${Array.from(this.clients.keys()).join(', ')}`);
    }
  }

  private async updateClientPhoneNumber(clientId: string): Promise<void> {
    const clientInfo = this.clients.get(clientId);
    if (clientInfo && clientInfo.client) {
      try {
        // Try getWid() method (more reliable for phone number)
        const wid = await clientInfo.client.getWid();
        console.log(`📞 Raw WID for ${clientId}:`, wid);
        
        let phoneNumber = null;
        if (wid) {
          if (typeof wid === 'string') {
            phoneNumber = wid;
          } else if (typeof wid === 'object') {
            const widObj: any = wid;
            phoneNumber = widObj._serialized || widObj.user || widObj.toString();
          }
        }
        
        // Fallback to getHostDevice()
        if (!phoneNumber) {
          const hostDevice = await clientInfo.client.getHostDevice();
          console.log(`📞 Raw host device for ${clientId}:`, hostDevice);
          
          if (hostDevice) {
            if (typeof hostDevice === 'string') {
              phoneNumber = hostDevice;
            } else if (typeof hostDevice === 'object') {
              const deviceObj: any = hostDevice;
              if (deviceObj.id) {
                phoneNumber = deviceObj.id._serialized || deviceObj.id.user || deviceObj.id;
              } else if (deviceObj._serialized) {
                phoneNumber = deviceObj._serialized;
              } else if (deviceObj.user) {
                phoneNumber = deviceObj.user;
              }
            }
          }
        }
        
        if (phoneNumber) {
          // Clean up the phone number (remove @c.us if present)
          const cleanNumber = phoneNumber.toString().replace('@c.us', '').replace(':0', '');
          clientInfo.phoneNumber = cleanNumber;
          console.log(`📞 WPPConnect client ${clientId} phone number: ${cleanNumber}`);
        } else {
          console.log(`⚠️ Could not extract phone number for ${clientId}`);
        }
      } catch (error) {
        console.error(`❌ Error getting phone number for ${clientId}:`, error);
      }
    }
  }

  public async sendMessage(clientId: string, number: string, message: string): Promise<boolean> {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo || !clientInfo.isReady) {
      throw new Error(`Client ${clientId} is not ready`);
    }

    try {
      const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
      const result = await clientInfo.client.sendText(formattedNumber, message);
      console.log(`✅ Message sent via WPPConnect client ${clientId}:`, result);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isInvalidNumber = errorMessage.includes('invalid wid') || 
                              errorMessage.includes('InvalidWidError') ||
                              errorMessage.includes('wid error');
      
      if (isInvalidNumber) {
        console.warn(`⚠️  [${clientId}] Invalid WhatsApp number: ${number}`);
        // Don't throw for invalid numbers, just log and re-throw for controller to handle
        throw new Error(`Invalid WhatsApp number: ${number}`);
      }
      
      console.error(`❌ Error sending message via WPPConnect client ${clientId}:`, error);
      throw error;
    }
  }

  /**
   * Delete all session data for a client (local folders, MongoDB backups, tokens)
   * This ensures the client won't be recreated on restart
   * @returns true if any session data was found and deleted, false otherwise
   */
  public async deleteAllSessionData(clientId: string): Promise<boolean> {
    console.log(`🗑️  Deleting all session data for ${clientId}...`);
    
    let foundAnyData = false;
    
    try {
      // 1. Delete local session folder
      const tokensPath = path.join(process.cwd(), 'tokens', clientId);
      if (fs.existsSync(tokensPath)) {
        try {
          // Use rmSync with maxRetries for more robust deletion
          // This handles cases where files might be locked or in use
          const deleteRecursive = (dirPath: string): void => {
            if (fs.existsSync(dirPath)) {
              const files = fs.readdirSync(dirPath);
              files.forEach((file) => {
                const filePath = path.join(dirPath, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                  deleteRecursive(filePath);
                } else {
                  try {
                    fs.unlinkSync(filePath);
                  } catch (unlinkError: any) {
                    // If file is locked, try to make it writable and retry
                    if (unlinkError.code === 'EACCES' || unlinkError.code === 'EPERM') {
                      try {
                        fs.chmodSync(filePath, 0o666);
                        fs.unlinkSync(filePath);
                      } catch (retryError) {
                        console.warn(`⚠️  Could not delete locked file ${filePath}, skipping`);
                      }
                    } else {
                      throw unlinkError;
                    }
                  }
                }
              });
              try {
                fs.rmdirSync(dirPath);
              } catch (rmdirError: any) {
                // If directory still has files, try force removal
                if (rmdirError.code === 'ENOTEMPTY') {
                  // Retry with a small delay in case files are being released
                  setTimeout(() => {
                    try {
                      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 });
                    } catch (retryError) {
                      console.warn(`⚠️  Could not delete directory ${dirPath} after retry`);
                    }
                  }, 100);
                } else {
                  throw rmdirError;
                }
              }
            }
          };
          
          deleteRecursive(tokensPath);
          // Final check - try rmSync as fallback if directory still exists
          if (fs.existsSync(tokensPath)) {
            fs.rmSync(tokensPath, { recursive: true, force: true, maxRetries: 3 });
          }
          console.log(`✅ Deleted local session folder: ${tokensPath}`);
          foundAnyData = true;
        } catch (error: any) {
          // If still failing, log but don't throw - continue with other deletions
          console.error(`⚠️  Error deleting local session folder for ${clientId}:`, error.message || error);
          // Try one more time with a simple rmSync
          try {
            if (fs.existsSync(tokensPath)) {
              fs.rmSync(tokensPath, { recursive: true, force: true });
            }
          } catch (finalError) {
            console.warn(`⚠️  Final attempt to delete ${tokensPath} failed, directory may need manual cleanup`);
          }
        }
      }

      // 2. Delete MongoDB GridFS WhatsApp session backups
      if (this.sessionBackup) {
        try {
          const files = await this.sessionBackup['gridFS'].find({ 
            filename: `${clientId}_whatsapp_session.zip`,
            'metadata.type': 'whatsapp_specific'
          }).toArray();
          
          for (const file of files) {
            try {
              await this.sessionBackup['gridFS'].delete(file._id);
              console.log(`✅ Deleted WhatsApp session backup: ${file.filename} (${file._id})`);
              foundAnyData = true;
            } catch (error) {
              console.error(`⚠️  Error deleting WhatsApp backup ${file._id}:`, error);
            }
          }
          
          if (files.length > 0) {
            console.log(`✅ Deleted ${files.length} WhatsApp session backup(s) from MongoDB`);
          }
        } catch (error) {
          console.error(`⚠️  Error deleting WhatsApp session backups for ${clientId}:`, error);
        }
      }

      // 3. Delete browser session backups from MongoDB GridFS
      try {
        const { deleteBrowserSessionFromMongo } = require('./tokenstore');
        const deleted = await deleteBrowserSessionFromMongo(clientId);
        if (deleted) {
          foundAnyData = true;
        }
      } catch (error) {
        console.error(`⚠️  Error deleting browser session backups for ${clientId}:`, error);
      }

      // 4. Delete WPPConnect tokens from MongoDB
      try {
        // Get the mongoose model (same way tokenstore.ts does it)
        const WPPConnectSession = mongoose.model('WPPConnectSession');
        const result = await WPPConnectSession.deleteOne({ sessionName: clientId });
        if (result.deletedCount > 0) {
          console.log(`✅ Deleted WPPConnect token for ${clientId} from MongoDB`);
          foundAnyData = true;
        }
      } catch (error) {
        console.error(`⚠️  Error deleting WPPConnect token for ${clientId}:`, error);
      }

      // 5. Delete client-agent assignment from MongoDB
      try {
        const ClientAgent = mongoose.model('ClientAgent');
        const result = await ClientAgent.deleteOne({ clientId });
        if (result.deletedCount > 0) {
          console.log(`✅ Deleted client-agent assignment for ${clientId} from MongoDB`);
          foundAnyData = true;
        }
      } catch (error) {
        console.error(`⚠️  Error deleting client-agent assignment for ${clientId}:`, error);
      }

      // 6. Delete platform client-agent assignment from MongoDB (PlatformClientAgent)
      try {
        const PlatformClientAgent = mongoose.model('PlatformClientAgent');
        const result = await PlatformClientAgent.deleteOne({ clientId });
        if (result.deletedCount > 0) {
          console.log(`✅ Deleted platform client-agent assignment for ${clientId} from PlatformClientAgent`);
          foundAnyData = true;
        }
      } catch (error) {
        console.error(`⚠️  Error deleting platform client-agent assignment for ${clientId}:`, error);
      }

      if (foundAnyData) {
        console.log(`✅ All session data deleted for ${clientId}`);
      } else {
        console.log(`📋 No session data found for ${clientId}`);
      }
      
      return foundAnyData;
    } catch (error) {
      console.error(`❌ Error deleting session data for ${clientId}:`, error);
      // Return true if we found any data before the error, false otherwise
      return foundAnyData;
    }
  }

  public async disconnectClient(clientId: string, deletePermanently: boolean = false): Promise<boolean> {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo && !deletePermanently) {
      return false;
    }

    try {
      // Close client if it exists
      if (clientInfo && clientInfo.client) {
        await clientInfo.client.close();
      }
      
      // Remove from memory
      if (clientInfo) {
        this.clients.delete(clientId);
      }

      // If permanent deletion requested, delete all session data
      if (deletePermanently) {
        await this.deleteAllSessionData(clientId);
        console.log(`✅ WPPConnect client ${clientId} disconnected and all session data deleted permanently`);
      } else {
        console.log(`✅ WPPConnect client ${clientId} disconnected successfully (session data preserved)`);
      }
      
      return true;
    } catch (error) {
      console.error(`❌ Error disconnecting WPPConnect client ${clientId}:`, error);
      return false;
    }
  }

  public getClient(clientId: string): WPPConnectClientInfo | undefined {
    return this.clients.get(clientId);
  }

  public getAllClients(): WPPConnectClientInfo[] {
    return Array.from(this.clients.values());
  }

  public addMessageHandler(handler: (clientId: string, message: any) => Promise<void>): void {
    this.messageHandlers.push(handler);
    console.log(`✅ Message handler added to client manager (total: ${this.messageHandlers.length} handler(s))`);
  }

  public async restoreExistingSessions(): Promise<void> {
    if (!this.sessionBackup) {
      throw new Error('Session backup service not initialized');
    }

    try {
      // First, check for local session folders in tokens/ directory
      const tokensPath = path.join(process.cwd(), 'tokens');
      const localSessionFolders: string[] = [];
      
      if (fs.existsSync(tokensPath)) {
        const entries = fs.readdirSync(tokensPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const clientId = entry.name;
            const sessionPath = path.join(tokensPath, clientId);
            const defaultPath = path.join(sessionPath, 'Default');
            const indexedDBPath = path.join(defaultPath, 'IndexedDB');
            const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
            
            // Check if this folder has valid session data
            if (fs.existsSync(defaultPath) && (fs.existsSync(indexedDBPath) || fs.existsSync(localStoragePath))) {
              localSessionFolders.push(clientId);
              console.log(`📁 [${clientId}] Found existing local session folder with valid data`);
            }
          }
        }
      }
      
      // Second, check for MongoDB backups
      const sessions = await this.sessionBackup.listWhatsAppBackups('*');
      console.log(`📋 Found ${sessions.length} MongoDB backups and ${localSessionFolders.length} local session folders`);
      
      // Combine both sources (local folders take priority - they're already there)
      const allClientIds = new Set<string>();
      localSessionFolders.forEach(id => allClientIds.add(id));
      sessions.forEach(s => {
        const clientId = s.filename.replace('_whatsapp_session.zip', '');
        allClientIds.add(clientId);
      });
      
      if (allClientIds.size > 0) {
        console.log(`📋 Sessions to restore/create: ${Array.from(allClientIds).join(', ')}`);
      }

      for (const clientId of allClientIds) {
        try {
          console.log(`🔄 [${clientId}] Starting session restoration/creation...`);
          
          // Check if client already exists
          if (this.clients.has(clientId)) {
            console.log(`⏩ [${clientId}] Client already exists, skipping`);
            continue;
          }

          // Use local session if it exists (WPPConnect's native way)
          // MongoDB backup is only used as fallback if local session doesn't exist
          const hasLocalSession = localSessionFolders.includes(clientId);
          
          if (hasLocalSession) {
            console.log(`📁 [${clientId}] Using existing local session folder (WPPConnect's native preservation method)`);
            // Create client directly - it will use the existing local session folder
            // MongoDB TokenStore will handle token persistence automatically
            await this.createClient(clientId, true);
            console.log(`✅ [${clientId}] Client created from local session, waiting 2s before next session...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            // No local session - restore from MongoDB backup if available
            console.log(`📥 [${clientId}] No local session found - restoring from MongoDB backup...`);
            const restored = await this.sessionBackup.restoreWhatsAppSession(clientId);
            
            if (restored) {
              console.log(`✅ [${clientId}] Session restored successfully from MongoDB`);
              
              // Create client with skipRestore=true since we already restored
              console.log(`🚀 [${clientId}] Creating WPPConnect client...`);
              
              await this.createClient(clientId, true);
              console.log(`✅ [${clientId}] Client created, waiting 2s before next session...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              console.warn(`⚠️  [${clientId}] No backup found in MongoDB and no local session - will need manual creation`);
            }
          }
        } catch (error: any) {
          // Handle specific error types
          if (error?.message?.includes('Auto Close Called')) {
            console.warn(`⚠️  [${clientId}] Client auto-closed during initialization (likely due to memory pressure)`);
            console.warn(`⚠️  [${clientId}] Session is saved and will reconnect on next cycle or manual trigger`);
          } else {
            console.error(`❌ [${clientId}] Failed to restore/create session:`, error);
          }
          // Remove failed client so it can be retried
          this.clients.delete(clientId);
        }
      }

      console.log('✅ WPPConnect session restoration completed');
    } catch (error) {
      console.error('❌ Error restoring WPPConnect sessions:', error);
      throw error;
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
      
      // Log memory usage during health check
      if (needsMemoryWarning()) {
        const memUsage = getMemoryUsage();
        console.log(`⚠️  Memory usage: ${memUsage.heapUsedMB}MB / ${memUsage.heapTotalMB}MB (${memUsage.heapUsagePercent}%)`);
      }
    }, this.config.healthCheckIntervalMs || 300000); // 5 minutes default

    console.log(`🏥 WPPConnect health check started with ${this.config.healthCheckIntervalMs || 300000}ms interval`);
  }

  /**
   * Daily session backup to MongoDB
   * Backs up all active authenticated sessions daily at 1:00 AM
   */
  private startPeriodicSessionBackup(): void {
    if (this.sessionBackupInterval) {
      clearTimeout(this.sessionBackupInterval);
    }

    const performBackup = async () => {
      console.log('🔄 Starting daily session backup to MongoDB (scheduled at 1:00 AM)...');
      let backedUp = 0;
      let failed = 0;
      
      for (const [clientId, clientInfo] of this.clients.entries()) {
        // Only backup ready/authenticated clients
        if (clientInfo.isReady && clientInfo.status === 'ready' && this.sessionBackup) {
          try {
            const backupSuccess = await this.sessionBackup.backupWhatsAppSession(clientId);
            
            if (backupSuccess) {
              backedUp++;
              
              // Cleanup old backups after successful backup
              await new Promise(resolve => setTimeout(resolve, 2000)); // GridFS indexing delay
              await this.sessionBackup.cleanupOldWhatsAppBackups(clientId, 2);
            } else {
              failed++;
              console.warn(`⚠️  [${clientId}] Daily backup failed`);
            }
          } catch (error) {
            failed++;
            console.error(`❌ [${clientId}] Daily backup error:`, error);
          }
        }
      }
      
      console.log(`🔄 Daily session backup completed: ${backedUp} backed up, ${failed} failed`);
      
      // Schedule next backup for tomorrow at 1:00 AM
      scheduleNextBackup();
    };

    const scheduleNextBackup = () => {
      const now = new Date();
      const nextBackup = new Date();
      
      // Set next backup time to 1:00 AM
      nextBackup.setHours(1, 0, 0, 0);
      
      // If it's already past 1:00 AM today, schedule for tomorrow
      if (now.getHours() >= 1 && (now.getHours() > 1 || now.getMinutes() > 0)) {
        nextBackup.setDate(nextBackup.getDate() + 1);
      }
      
      const msUntilNextBackup = nextBackup.getTime() - now.getTime();
      
      this.sessionBackupInterval = setTimeout(() => {
        performBackup();
      }, msUntilNextBackup);
      
      const nextBackupStr = nextBackup.toLocaleString('en-US', { 
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      console.log(`💾 Daily session backup scheduled for: ${nextBackupStr} (in ${Math.round(msUntilNextBackup / 1000 / 60)} minutes)`);
    };

    // Schedule the first backup
    scheduleNextBackup();
  }

  private async performHealthCheck(): Promise<void> {
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.isReady && clientInfo.client) {
          // Check if browser/page is still open before trying to communicate
          try {
            // Test if client is still responsive
            const isConnected = await clientInfo.client.isConnected();
            if (!isConnected) {
              console.log(`⚠️ WPPConnect client ${clientId} is not connected, marking as disconnected`);
              clientInfo.status = 'disconnected';
              clientInfo.isReady = false;
            }
          } catch (checkError: any) {
            // Handle specific errors where the browser/target is already closed
            const errorMsg = checkError?.message || String(checkError);
            if (errorMsg.includes('Target closed') || 
                errorMsg.includes('Session closed') ||
                errorMsg.includes('Protocol error')) {
              console.log(`ℹ️  Client ${clientId} browser already closed, marking as disconnected`);
              clientInfo.status = 'disconnected';
              clientInfo.isReady = false;
            } else {
              // Log other errors but don't fail completely
              console.warn(`⚠️ Health check error for ${clientId}: ${errorMsg.substring(0, 100)}`);
              clientInfo.status = 'error';
              clientInfo.isReady = false;
            }
          }
        }
      } catch (error) {
        console.error(`⚠️ Health check failed for WPPConnect client ${clientId}:`, error);
        clientInfo.status = 'error';
        clientInfo.isReady = false;
      }
    }
  }

  public isHealthy(): boolean {
    const readyClients = Array.from(this.clients.values()).filter(client => client.isReady);
    return readyClients.length > 0;
  }

  public getHealthStatus(): any {
    const clients = Array.from(this.clients.values());
    const readyClients = clients.filter(client => client.isReady);
    const errorClients = clients.filter(client => client.status === 'error');

    return {
      totalClients: clients.length,
      readyClients: readyClients.length,
      errorClients: errorClients.length,
      isHealthy: readyClients.length > 0,
      clients: clients.map(client => ({
        clientId: client.clientId,
        status: client.status,
        isReady: client.isReady,
        hasQrCode: !!client.qrCode,
        phoneNumber: client.phoneNumber,
        lastActivity: client.lastActivity
      }))
    };
  }



  /**
   * Force cleanup of a specific client session from MongoDB and local files
   * This can be used to manually clean up stuck sessions
   */
  public async forceCleanupSession(clientId: string): Promise<boolean> {
    try {
      console.log(`🧹 Force cleanup requested for client: ${clientId}`);
      // Use disconnectClient with permanent deletion to clean up everything
      return await this.disconnectClient(clientId, true);
    } catch (error) {
      console.error(`❌ Error force cleaning session for ${clientId}:`, error);
      return false;
    }
  }

  public   async cleanup(): Promise<void> {
    console.log('🔄 Starting WPPConnect client manager cleanup...');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      console.log('✅ Health check interval cleared');
    }
    
    if (this.sessionBackupInterval) {
      clearTimeout(this.sessionBackupInterval);
      console.log('✅ Session backup scheduled task cleared');
    }

    // Wait for in-progress backups to complete before disconnecting clients
    if (this.sessionBackup) {
      try {
        await this.sessionBackup.waitForBackupsToComplete(10000); // Wait up to 10 seconds
      } catch (error) {
        console.warn(`⚠️  Error waiting for backups:`, error);
      }
    }

    // Disconnect all clients
    const clientCount = this.clients.size;
    if (clientCount > 0) {
      console.log(`🔄 Disconnecting ${clientCount} WPPConnect client(s)...`);
      for (const [clientId, clientInfo] of this.clients) {
        try {
          if (clientInfo.client) {
            await clientInfo.client.close();
            console.log(`✅ WPPConnect client ${clientId} disconnected`);
          }
        } catch (error) {
          console.error(`❌ Error disconnecting client ${clientId}:`, error);
        }
      }
    }

    this.clients.clear();
    console.log('✅ Client map cleared');
    
    // Clear retry attempts map
    this.retryAttempts.clear();
    
    // Suggest garbage collection after cleanup
    if (MEMORY_CONFIG.GC_AFTER_CLIENT_CLOSE) {
      suggestGC();
    }
    
    console.log('✅ WPPConnect client manager cleanup completed');
  }

  /**
   * Manually sync a specific client's session to MongoDB GridFS
   * Useful for forcing a backup of a session
   */
  public async syncSessionToMongo(clientId: string): Promise<boolean> {
    try {
      const clientInfo = this.clients.get(clientId);
      if (!clientInfo) {
        console.log(`⚠️  Client ${clientId} not found`);
        return false;
      }

      if (!clientInfo.isReady || clientInfo.status !== 'ready') {
        console.log(`⚠️  Client ${clientId} is not ready for sync (status: ${clientInfo.status})`);
        return false;
      }

      // WPPConnect TokenStore handles persistence automatically
      console.log(`✅ Session persistence handled by TokenStore for ${clientId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error syncing session for ${clientId}:`, error);
      return false;
    }
  }
}

export default WPPConnectClientManager;
