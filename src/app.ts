import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { WPPConnectWhatsAppService } from './services/whatsapp.service';
import { WPPConnectMessageHandler } from './core/message-handler';
import { WPPConnectWhatsAppController } from './controllers/whatsapp.controller';
import { ApiController } from './controllers/api.controller';
import { createWhatsAppRoutes } from './routes/whatsapp.routes';
import { createApiRoutes } from './routes/api.routes';
import { Environment } from './types';
import { swaggerSpec } from './config/swagger';
import { createAuthMiddleware } from './middleware/auth.middleware';
import { AutoRestartService } from './services/auto-restart.service';
import { MemoryMonitorService } from './services/memory-monitor.service';
import fs from 'fs';

// ============================================
// WPPConnect WhatsApp Bot Application
// ============================================

export class WPPConnectWhatsAppBotApp {
  private app: Express;
  private whatsappService: WPPConnectWhatsAppService;
  private messageHandler: WPPConnectMessageHandler;
  private whatsappController: WPPConnectWhatsAppController;
  private apiController: ApiController;
  private autoRestartService: AutoRestartService;
  private memoryMonitor: MemoryMonitorService;

  constructor(private env: Environment) {
    this.app = express();
    
    // Configure WPPConnect service
    const whatsappConfig = {
      chromiumPath: env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      puppeteerArgs: [
        // Security and sandbox
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        
        // Memory optimization (reduced limits for better efficiency)
        '--memory-pressure-off',
        '--max_old_space_size=512',
        '--max-heap-size=512',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
        '--disable-background-sync',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--disable-web-security',
        
        // Performance optimization
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-gpu-sandbox',
        '--disable-software-rasterizer',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--no-zygote',
        '--no-default-browser-check',
        
        // Additional memory optimization flags
        '--aggressive-cache-discard',
        '--enable-aggressive-domstorage-flushing',
        '--disable-background-mode',
        
        // Resource limits (adjusted for stability)
        '--memory-pressure-off',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-networking',
        '--disable-background-sync',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--disable-web-security',
        
        // UI optimization
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        
        // SSL and certificates
        '--ignore-ssl-errors',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors-list',
        '--allow-running-insecure-content',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-javascript',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-networking',
        '--disable-background-sync',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--disable-web-security'
      ],
      mongoUri: env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-bot',
      backupSyncIntervalMs: 600000, // 10 minutes (reduced frequency)
      maxRetries: 3, // Reduced retries
      retryDelayMs: 5000, // Increased delay between retries
      healthCheckIntervalMs: 600000 // 10 minutes (optimized for memory efficiency)
    };
    
    // Initialize services
    this.whatsappService = new WPPConnectWhatsAppService(whatsappConfig);
    this.messageHandler = new WPPConnectMessageHandler(this.whatsappService, env);
    this.whatsappController = new WPPConnectWhatsAppController(this.whatsappService, this.messageHandler, env);
    this.apiController = new ApiController(this.whatsappService as any, env);
    this.autoRestartService = new AutoRestartService(env, async () => { 
      await this.gracefulShutdown(); 
    });
    
    // Initialize memory monitor
    this.memoryMonitor = new MemoryMonitorService();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupMessageHandling();
    this.setupMemoryOptimization();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  private setupRoutes(): void {
    // Setup Swagger documentation with Monokai theme
    let monokaiCSS = '';
    try {
      monokaiCSS = fs.readFileSync('public/css/theme-monokai.css', 'utf8');
    } catch (error) {
      console.warn('⚠️ Monokai CSS file not found, using default Swagger theme');
    }
    
    // Setup Swagger UI with minimal configuration for debugging
    this.app.use('/documentation', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customCss: `
        .swagger-ui .topbar { display: none }
        ${monokaiCSS}
      `,
      customSiteTitle: 'WPPConnect WhatsApp Bot API Documentation'
    }));
    
    // Create authentication middleware
    const authMiddleware = createAuthMiddleware(this.env);
    
    // Setup routes with controllers and authentication
    this.app.use('/api/whatsapp', authMiddleware.authenticate, createWhatsAppRoutes(this.whatsappController));
    
    // API routes with authentication
    this.app.use('/api', authMiddleware.authenticate, createApiRoutes(this.apiController));
    
    // Legacy routes for backward compatibility
    this.app.get('/health', (req, res) => this.apiController.healthCheck(req, res));
    this.app.get('/memory/stats', (req, res) => this.apiController.getMemoryStats(req, res));
    this.app.get('/test', (req, res) => this.apiController.testClient(req, res));
    this.app.get('/qr', (req, res) => this.apiController.getQRCode(req, res));
    this.app.get('/qr/status', (req, res) => this.apiController.getQRStatus(req, res));
    this.app.get('/bot/status', (req, res) => this.apiController.getBotStatus(req, res));
    this.app.post('/bot/disconnect', (req, res) => this.apiController.disconnectClient(req, res));
    
    // Auto-restart status endpoint
    this.app.get('/restart/status', (req, res) => {
      const isEnabled = this.autoRestartService.isEnabled();
      const cronExpression = this.autoRestartService.getCronExpression();
      const nextExecution = this.autoRestartService.getNextExecution();
      
      res.json({
        success: true,
        autoRestart: {
          enabled: isEnabled,
          cronExpression: cronExpression || null,
          nextExecution: nextExecution ? nextExecution.toISOString() : null,
          nextExecutionHuman: nextExecution ? nextExecution.toLocaleString() : null
        }
      });
    });
    
    // Memory status endpoint
    this.app.get('/memory/status', (req, res) => {
      const memoryStats = this.memoryMonitor.getStats();
      res.json({
        success: true,
        memory: memoryStats
      });
    });
    
    // Debug endpoint to check MongoDB tokens
    this.app.get('/debug/mongo-tokens', (req, res) => this.apiController.debugMongoTokens(req, res));
  }

  private setupMessageHandling(): void {
    this.whatsappService.addMessageHandler(async (clientId: string, message: any) => {
      await this.messageHandler.handleIncomingMessage(clientId, message);
    });
  }

  private setupMemoryOptimization(): void {
    // Start memory monitor
    this.memoryMonitor.start(60000); // Check every minute
    
    // Memory tracking variables for intelligent management
    let lastMemoryUsage: NodeJS.MemoryUsage | null = null;
    let memoryTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    let consecutiveHighMemoryChecks = 0;
    
    // Smart garbage collection with adaptive intervals
    if (global.gc) {
      console.log('✅ Garbage collection is available (--expose-gc flag detected)');
      setInterval(() => {
        try {
          const memUsage = process.memoryUsage();
          const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
          
          // Adaptive GC based on memory usage
          if (heapUsedMB > 300) {
            // Aggressive GC for high memory
            global.gc!();
            setTimeout(() => global.gc!(), 100);
          } else if (heapUsedMB > 200) {
            // Standard GC for medium memory
            global.gc!();
          }
          // Skip GC for low memory usage to avoid overhead
        } catch (error) {
          console.warn('⚠️ Garbage collection failed:', error);
        }
      }, 600000); // 10 minutes (increased from 5 minutes)
    }

    // Optimized memory monitoring (reduced frequency for better performance)
    setInterval(() => {
      const memUsage = process.memoryUsage();
      const memUsageMB = {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
      };

      // Analyze memory trend for intelligent management
      if (lastMemoryUsage) {
        const heapDiff = memUsage.heapUsed - lastMemoryUsage.heapUsed;
        if (heapDiff > 10 * 1024 * 1024) { // 10MB increase
          memoryTrend = 'increasing';
        } else if (heapDiff < -10 * 1024 * 1024) { // 10MB decrease
          memoryTrend = 'decreasing';
        } else {
          memoryTrend = 'stable';
        }
      }
      lastMemoryUsage = memUsage;

      // Smart logging - only log when significant or high usage
      if (memUsageMB.heapUsed >= 200 || memUsageMB.rss >= 100) {
        console.log(`📊 Memory Usage: RSS=${memUsageMB.rss}MB, Heap=${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB, External=${memUsageMB.external}MB`);
        consecutiveHighMemoryChecks++;
      } else {
        consecutiveHighMemoryChecks = 0;
      }

      // Adaptive memory management with multiple thresholds
      if (memUsageMB.heapUsed >= 400) {
        console.warn(`🚨 CRITICAL memory usage: ${memUsageMB.heapUsed}MB - Emergency cleanup triggered`);
        if (global.gc) {
          global.gc!();
          setTimeout(() => global.gc!(), 100);
          setTimeout(() => global.gc!(), 200);
        }
      } else if (memUsageMB.heapUsed >= 300) {
        console.warn(`⚠️ High memory usage: ${memUsageMB.heapUsed}MB - Aggressive cleanup triggered`);
        if (global.gc) {
          global.gc!();
          setTimeout(() => global.gc!(), 100);
        }
      } else if (memUsageMB.heapUsed >= 200 && memoryTrend === 'increasing') {
        console.log(`📈 Memory trend: increasing - Proactive cleanup triggered`);
        if (global.gc) {
          global.gc!();
        }
      }
    }, 300000); // Every 5 minutes (reduced from 1 minute)

    console.log('🧠 Advanced memory optimization enabled for WPPConnect');
  }

  public async initialize(): Promise<void> {
    try {
      console.log('🔗 Initializing WPPConnect WhatsApp Bot Application...');
      
      // Initialize WhatsApp service (connects to MongoDB and starts health checks)
      await this.whatsappService.initialize();
      console.log('✅ WPPConnect WhatsApp service initialized');
      
      // Restore existing sessions from MongoDB (NON-BLOCKING - runs in background)
      setImmediate(() => {
        this.whatsappService.restoreExistingSessions()
          .then(() => {
            console.log('✅ Existing WPPConnect sessions restored');
            // Load agent assignments after sessions are restored
            return this.whatsappService.loadAgentAssignments();
          })
          .then(() => {
            console.log('✅ WPPConnect agent assignments loaded');
          })
          .catch(error => {
            console.error('❌ Error restoring sessions or loading assignments:', error);
          });
      });
      console.log('🔄 Session restoration queued in background...');
      
      // Initialize auto-restart service
      this.autoRestartService.initialize();
      
      console.log('🚀 WPPConnect WhatsApp Bot API ready - sessions will restore in background');
    } catch (error) {
      console.error('❌ Failed to initialize WPPConnect WhatsApp Bot Application:', error);
      throw error;
    }
  }

  public async start(port: number = 3003): Promise<void> {
    try {
      await this.initialize();
      
      this.app.listen(port, () => {
        console.log('🌐 WPPConnect WhatsApp Bot API server running on port', port);
        console.log('📱 Health check: http://localhost:' + port + '/health');
        console.log('🔧 API endpoints: http://localhost:' + port + '/api/whatsapp/*');
        console.log('📚 API Documentation: http://localhost:' + port + '/documentation');
      });
    } catch (error) {
      console.error('❌ Failed to start WPPConnect WhatsApp Bot Application:', error);
      throw error;
    }
  }

  public async gracefulShutdown(): Promise<void> {
    console.log('⏹️  Starting WPPConnect graceful shutdown...');
    
    try {
      // Stop auto-restart service
      this.autoRestartService.stop();
      
      // Stop memory monitor
      this.memoryMonitor.stop();
      
      // Disconnect all WPPConnect clients
      const clients = this.whatsappService.getAllClients();
      for (const client of clients) {
        try {
          await this.whatsappService.disconnectClient(client.clientId);
          console.log(`✅ WPPConnect client ${client.clientId} disconnected successfully`);
        } catch (error) {
          console.error(`❌ Error disconnecting WPPConnect client ${client.clientId}:`, error);
        }
      }
      
      // Cleanup WhatsApp service
      await this.whatsappService.cleanup();
      console.log('✅ WPPConnect WhatsApp service cleanup completed');
      
      console.log('✅ WPPConnect WhatsApp Bot Application shutdown complete');
      console.log('🔄 Graceful shutdown completed. Process will exit for restart.');
      
    } catch (error) {
      console.error('❌ Error during WPPConnect graceful shutdown:', error);
    }
  }
}

export default WPPConnectWhatsAppBotApp;
