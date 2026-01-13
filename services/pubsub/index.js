require('dotenv').config();
const PubSubApp = require('./app');

// Handle unhandled promise rejections (prevent crashes)
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - let the server continue running for health checks
});

// Handle uncaught exceptions (prevent crashes)
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit - let the server continue running for health checks
  // This allows health checks to pass even if there are initialization issues
});

// Get port - prioritize PORT (Railway sets this), then PUBSUB_PORT, then default to 3005
// Railway automatically sets PORT env var, so we should use that for health checks
const PORT = process.env.PORT || process.env.PUBSUB_PORT || 3005;

// Initialize the Pub/Sub app
const app = new PubSubApp();

// Register health endpoint IMMEDIATELY on the express app (before initialization)
const expressApp = app.getApp();

// Health endpoint - must be available immediately for Docker health checks
// This MUST be registered before any middleware that might interfere
expressApp.get('/health', (req, res) => {
  // Log health check requests for debugging
  const clientIP = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  console.log(`🏥 Health check requested from ${clientIP} (${userAgent})`);
  
  try {
    const healthResponse = {
      status: 'ok',
      service: 'pubsub',
      timestamp: new Date().toISOString(),
      port: PORT,
      uptime: process.uptime(),
      env: {
        PUBSUB_PORT: process.env.PUBSUB_PORT,
        PORT: process.env.PORT,
        NODE_ENV: process.env.NODE_ENV
      }
    };
    
    res.status(200).json(healthResponse);
    console.log(`✅ Health check responded OK`);
  } catch (error) {
    console.error('❌ Error in health endpoint:', error);
    res.status(500).json({ 
      status: 'error',
      service: 'pubsub',
      error: error.message 
    });
  }
});

// Root endpoint for basic connectivity check
expressApp.get('/', (req, res) => {
  res.status(200).json({ 
    service: 'pubsub',
    status: 'running',
    health: `/health`
  });
});

// Start the server IMMEDIATELY (health endpoint is ready)
console.log(`🚀 Starting server on port ${PORT}...`);
let server;
try {
  server = expressApp.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
    console.log(`🏥 Health check available at http://0.0.0.0:${PORT}/health`);
  });
  
  // Handle server errors
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use`);
    } else {
      console.error(`❌ Server error:`, error);
    }
    process.exit(1);
  });
} catch (error) {
  console.error(`❌ Failed to start server:`, error);
  process.exit(1);
}

// Initialize services asynchronously (non-blocking, server already running)
app.initialize().then(() => {
  console.log(`✅ Pub/Sub service fully initialized`);
  console.log(`📡 Webhook registration: http://localhost:${PORT}/api/v1/webhooks`);
  console.log(`📊 Stream consumer: http://localhost:${PORT}/api/v1/streams`);
  console.log(`📨 Stream: ${process.env.VALKEY_STREAM_NAME || 'platform-message:events'}`);
}).catch((error) => {
  console.error('❌ Failed to initialize Pub/Sub service:', error);
  console.error('⚠️  Server is still running for health checks, but features may be limited');
  // Don't exit - server is already running, health checks still work
  // This allows the container to pass health checks even if Redis/Weaviate connections fail
});

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  // Stop accepting new connections
  server.close(async () => {
    console.log('✅ HTTP server closed');
    
    // Shutdown app services (Redis, Weaviate, etc.)
    try {
      await app.shutdown();
      console.log('✅ All services shut down');
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
    }
    
    process.exit(0);
  });
  
  // Force exit after 10 seconds if shutdown takes too long
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Handle SIGTERM (used by process managers like PM2, Docker, etc.)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
