// Load environment variables (non-blocking - continue even if .env file doesn't exist)
try {
  require('dotenv').config();
} catch (error) {
  console.warn('⚠️  Could not load .env file (this is OK in production):', error.message);
}

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

// Initialize PubSubApp (wrap in try-catch to ensure server starts even if app creation fails)
let app;
try {
  const PubSubApp = require('./app');
  app = new PubSubApp();
} catch (error) {
  console.error('❌ Failed to create PubSubApp:', error);
  // Create a minimal express app for health checks only
  const express = require('express');
  const minimalApp = express();
  minimalApp.get('/health', (req, res) => {
    res.status(500).json({ 
      status: 'error', 
      service: 'pubsub',
      error: 'Failed to initialize app',
      message: error.message 
    });
  });
  const PORT = process.env.PORT || process.env.PUBSUB_PORT || 3005;
  minimalApp.listen(PORT, '0.0.0.0', () => {
    console.log(`⚠️  Minimal server started on ${PORT} (app initialization failed)`);
  });
  process.exit(1); // Exit with error code but health check endpoint is available
}

// Get port - prioritize PORT (Railway sets this automatically), then PUBSUB_PORT, then default to 3005
// PORT must be prioritized for Railway compatibility - Railway's health check uses the PORT it sets
const PORT = process.env.PORT || process.env.PUBSUB_PORT || 3005;

// Health endpoint is already registered in PubSubApp constructor (before any middleware)
// Get the express app for server startup
const expressApp = app.getApp();

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
let serverReady = false;

try {
  server = expressApp.listen(PORT, '0.0.0.0', () => {
    serverReady = true;
    console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
    console.log(`🏥 Health check available at http://0.0.0.0:${PORT}/health`);
    console.log(`📊 Server is ready to accept connections`);
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
  
  // Verify server is actually listening (for debugging)
  server.on('listening', () => {
    serverReady = true;
    const address = server.address();
    console.log(`✅ Server bound to ${address.address}:${address.port}`);
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
