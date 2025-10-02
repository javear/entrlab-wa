import { create, Whatsapp } from '@wppconnect-team/wppconnect';
import mongoose from 'mongoose';
import { WPPConnectMongoTokenStore } from './tokenstore';

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
  private tokenStore: WPPConnectMongoTokenStore | null = null;
  private isMongoConnected: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private retryAttempts: Map<string, number> = new Map();

  constructor(config: WPPConnectClientManagerConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    await this.initializeMongoDB();
    this.startHealthCheck();
  }

  private async initializeMongoDB(): Promise<void> {
    try {
      if (mongoose.connection.readyState === 1) {
        this.isMongoConnected = true;
        this.tokenStore = new WPPConnectMongoTokenStore();
        await this.tokenStore.connect();
        console.log('✅ WPPConnect MongoDB TokenStore initialized');
      } else {
        throw new Error('MongoDB connection not available');
      }
    } catch (error) {
      console.error('❌ Failed to initialize WPPConnect MongoDB:', error);
      throw error;
    }
  }

  public async createClient(clientId: string): Promise<WPPConnectClientInfo> {
    if (this.clients.has(clientId)) {
      throw new Error(`Client with ID '${clientId}' already exists`);
    }

    console.log(`🚀 Creating new WPPConnect client: ${clientId}`);

    if (!this.isMongoConnected || !this.tokenStore) {
      throw new Error('MongoDB connection is required. Please ensure MONGODB_URI is set and MongoDB is connected.');
    }

    console.log(`🔗 Using WPPConnect MongoDB TokenStore for client ${clientId}`);

    // Add placeholder client info immediately so it's queryable
    const placeholderClientInfo: WPPConnectClientInfo = {
      clientId,
      client: null as any, // Will be set after creation
      isReady: false,
      lastActivity: new Date(),
      status: 'initializing'
    };
    this.clients.set(clientId, placeholderClientInfo);
    console.log(`📝 Client ${clientId} added to map with 'initializing' status`);

    try {
      // Set up unique browser folder for this client
      const path = require('path');
      const userDataDir = path.join(process.cwd(), 'tokens', clientId);
      console.log(`📁 Client ${clientId} browser folder: ${userDataDir}`);
      
      // Create WPPConnect client with MongoDB TokenStore
      const client = await create({
        session: clientId,
        tokenStore: this.tokenStore,
        folderNameToken: './tokens', // Browser profiles folder (temporary, can be cleaned)
        
        // Browser configuration
        headless: true,
        devtools: false,
        useChrome: true,
        debug: false,
        logQR: false, // Disable console QR - use API endpoint instead
        
        // CRITICAL: Explicitly set puppeteer userDataDir for multi-session support
        puppeteerOptions: {
          userDataDir: userDataDir,
          executablePath: this.config.chromiumPath,
          args: this.config.puppeteerArgs
        },
        
        // Browser arguments (optimized for memory)
        browserArgs: this.config.puppeteerArgs,
        
        // Callbacks
        statusFind: (statusSession, session) => {
          console.log(`📊 WPPConnect Status for ${session}: ${statusSession}`);
          this.updateClientStatus(clientId, statusSession);
          
          // CRITICAL: Save session when authenticated
          if (statusSession === 'isLogged' || statusSession === 'inChat') {
            console.log(`🔄 Status ${statusSession} detected - triggering session save for ${clientId}`);
            this.saveSessionToMongoDB(clientId).catch((error) => {
              console.error(`❌ Error in saveSessionToMongoDB for ${clientId}:`, error);
            });
          }
        },
        
        catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
          console.log(`📱 QR Code generated for ${clientId} (attempt ${attempts}) - Access via /api/whatsapp/clients/${clientId}/qr-image`);
          this.updateClientQR(clientId, base64Qr);
        },
        
        // Auto-close settings
        autoClose: 60000,
        
        // Additional options
        disableWelcome: true,
        updatesLog: true
      });

      console.log(`✅ WPPConnect client created: ${clientId}`);

      // Set up message handler
      client.onMessage(async (message) => {
        console.log(`📨 Message received on WPPConnect client ${clientId}:`, message.body);
        for (const handler of this.messageHandlers) {
          try {
            await handler(clientId, message);
          } catch (error) {
            console.error(`❌ Error in message handler for ${clientId}:`, error);
          }
        }
      });

      // Set up ready handler
      client.onStateChange(async (state) => {
        console.log(`🔄 WPPConnect client ${clientId} state changed: ${state}`);
        if (state === 'CONNECTED') {
          // Update client to ready state when connected
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'ready';
            clientInfo.isReady = true;
            clientInfo.lastActivity = new Date();
            console.log(`✅ WPPConnect client ${clientId} is now READY (CONNECTED)`);
            
            // Save session to MongoDB when connected
            this.saveSessionToMongoDB(clientId).catch((error) => {
              console.error(`❌ Error saving session for ${clientId}:`, error);
            });
          }
          this.updateClientPhoneNumber(clientId);
        }
      });

      // Update the placeholder with the actual client instance
      const existingClientInfo = this.clients.get(clientId);
      if (existingClientInfo) {
        existingClientInfo.client = client;
        existingClientInfo.lastActivity = new Date();
        console.log(`✅ WPPConnect client ${clientId} initialized successfully`);
        
        // CRITICAL: Save session immediately after client creation (WPPConnect handles this automatically)
        console.log(`🔄 WPPConnect will automatically save session to MongoDB via tokenStore`);
        
        // Update phone number if client is already authenticated (restored session)
        if (existingClientInfo.isReady) {
          await this.updateClientPhoneNumber(clientId);
          
          // WPPConnect automatically handles session saving via tokenStore
          console.log(`✅ Client ${clientId} is already ready - session managed by WPPConnect tokenStore`);
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
        console.log(`✅ WPPConnect client ${clientId} initialized successfully`);
        return clientInfo;
      }

    } catch (error) {
      console.error(`❌ Failed to create WPPConnect client ${clientId}:`, error);
      
      // Check if error is due to browser already running
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('browser is already running') || errorMessage.includes('userDataDir')) {
        console.log(`🔄 Browser lock detected for ${clientId}, attempting cleanup...`);
        
        try {
          // Try to clean up the browser folder locks
          const fs = require('fs');
          const path = require('path');
          const browserPath = path.join(process.cwd(), 'tokens', clientId);
          
          // Remove lock files
          const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
          for (const lockFile of lockFiles) {
            const lockPath = path.join(browserPath, lockFile);
            if (fs.existsSync(lockPath)) {
              fs.unlinkSync(lockPath);
              console.log(`🗑️  Removed lock file: ${lockFile}`);
            }
          }
          
          console.log(`✅ Browser locks cleaned up for ${clientId}, retrying...`);
          
          // Remove the failed placeholder
          this.clients.delete(clientId);
          
          // Retry creating the client
          return await this.createClient(clientId);
          
        } catch (cleanupError) {
          console.error(`❌ Failed to cleanup browser locks for ${clientId}:`, cleanupError);
        }
      }
      
      // Remove the placeholder client if creation failed
      this.clients.delete(clientId);
      console.log(`🗑️  Removed failed client ${clientId} from map`);
      
      // Also delete from MongoDB on failed creation
      if (this.tokenStore) {
        try {
          await this.tokenStore.removeToken(clientId);
          console.log(`🗑️  Deleted failed session from MongoDB: ${clientId}`);
        } catch (mongoError) {
          console.error(`⚠️  Failed to delete session from MongoDB for ${clientId}:`, mongoError);
        }
      }
      
      throw error;
    }
  }


  private async saveSessionToMongoDB(clientId: string): Promise<void> {
    try {
      console.log(`🔄 Attempting to save session for ${clientId} to MongoDB...`);
      const clientInfo = this.clients.get(clientId);
      console.log(`🔍 Client info for ${clientId}: exists=${!!clientInfo}, hasClient=${!!clientInfo?.client}, hasTokenStore=${!!this.tokenStore}`);
      
      if (clientInfo && clientInfo.client && this.tokenStore) {
        // Get session token from WPPConnect client
        const sessionToken = await clientInfo.client.getSessionTokenBrowser();
        
        if (sessionToken) {
          console.log(`🔑 Session token obtained for ${clientId}, saving to MongoDB...`);
          console.log(`🔑 Token keys: ${Object.keys(sessionToken).join(', ')}`);
          
          // Save to MongoDB via TokenStore
          const success = await this.tokenStore.setToken(clientId, sessionToken);
          
          if (success) {
            console.log(`💾 Successfully saved WPPConnect session to MongoDB: ${clientId}`);
          } else {
            console.error(`❌ Failed to save session to MongoDB for ${clientId}`);
          }
        } else {
          console.log(`⚠️ No session token available for ${clientId}`);
        }
      } else {
        console.log(`⚠️ Cannot save session for ${clientId}: clientInfo=${!!clientInfo}, client=${!!clientInfo?.client}, tokenStore=${!!this.tokenStore}`);
      }
    } catch (error) {
      console.error(`❌ Error saving session for ${clientId}:`, error);
    }
  }

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
          console.log(`✅ WPPConnect client ${clientId} status: ${status} → ready`);
          
          // WPPConnect automatically handles session saving via tokenStore
          console.log(`✅ WPPConnect automatically manages session persistence via tokenStore`);
          break;
        case 'notLogged':
          clientInfo.status = 'qr_required';
          clientInfo.isReady = false;
          break;
        case 'autocloseCalled':
        case 'qrReadError':
        case 'qrReadFail':
          // Clear authentication failures - delete from MongoDB
          console.log(`🗑️  Removing client ${clientId} - Authentication failed (${status})`);
          this.clients.delete(clientId);
          
          // Delete the session from MongoDB to prevent resurrection on restart
          if (this.tokenStore) {
            this.tokenStore.removeToken(clientId)
              .then(() => {
                console.log(`🗑️  Deleted failed session from MongoDB: ${clientId}`);
              })
              .catch((error) => {
                console.error(`⚠️  Failed to delete session from MongoDB for ${clientId}:`, error);
              });
          }
          return;
        case 'browserClose':
          // Browser close might be normal - only remove from map, keep session in MongoDB
          console.log(`🗑️  Removing client ${clientId} - Browser closed (${status})`);
          this.clients.delete(clientId);
          return;
        case 'desconnectedMobile':
        case 'serverClose':
          clientInfo.status = 'disconnected';
          clientInfo.isReady = false;
          console.log(`📴 WPPConnect client ${clientId} disconnected: ${status}`);
          break;
        default:
          // Don't override status if we don't recognize it
          console.log(`ℹ️  WPPConnect client ${clientId} unknown status: ${status}`);
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
      console.error(`❌ Error sending message via WPPConnect client ${clientId}:`, error);
      throw error;
    }
  }

  public async disconnectClient(clientId: string): Promise<boolean> {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo) {
      return false;
    }

    try {
      if (clientInfo.client) {
        await clientInfo.client.close();
      }
      this.clients.delete(clientId);
      console.log(`✅ WPPConnect client ${clientId} disconnected successfully`);
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
  }

  public async restoreExistingSessions(): Promise<void> {
    if (!this.tokenStore) {
      throw new Error('TokenStore not initialized');
    }

    try {
      const sessions = await this.tokenStore.listSessions();
      console.log(`📋 Found ${sessions.length} existing WPPConnect sessions in MongoDB`);

      for (const session of sessions) {
        const clientId = session.sessionName;
        console.log(`🔄 Restoring WPPConnect session for client: ${clientId}`);
        
        try {
          await this.createClient(clientId);
          console.log(`✅ Successfully restored WPPConnect session for client: ${clientId}`);
        } catch (error) {
          console.error(`❌ Failed to restore WPPConnect session for client ${clientId}:`, error);
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
    }, this.config.healthCheckIntervalMs || 300000); // 5 minutes default

    console.log(`🏥 WPPConnect health check started with ${this.config.healthCheckIntervalMs || 300000}ms interval`);
  }

  private async performHealthCheck(): Promise<void> {
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.isReady) {
          // Test if client is still responsive
          const isConnected = await clientInfo.client.isConnected();
          if (!isConnected) {
            console.log(`⚠️ WPPConnect client ${clientId} is not connected, marking as disconnected`);
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
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

  public async cleanup(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Disconnect all clients
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.client) {
          await clientInfo.client.close();
        }
        console.log(`✅ WPPConnect client ${clientId} disconnected successfully`);
      } catch (error) {
        console.error(`❌ Error disconnecting WPPConnect client ${clientId}:`, error);
      }
    }

    this.clients.clear();

    if (this.tokenStore) {
      await this.tokenStore.disconnect();
    }
  }
}

export default WPPConnectClientManager;
