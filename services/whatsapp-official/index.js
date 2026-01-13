require('dotenv').config();
const express = require('express');
const WhatsAppOfficialApp = require('./app');

const PORT = process.env.PORT || process.env.WA_OFFICIAL_PORT || 3004;

// Initialize the WhatsApp Business API app
const app = new WhatsAppOfficialApp();

// Register health endpoint IMMEDIATELY (before async initialization)
// This ensures health checks work even if initialization fails
const expressApp = app.getApp();
expressApp.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'whatsapp-official',
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

// Root endpoint for basic connectivity check
expressApp.get('/', (req, res) => {
  res.status(200).json({ 
    service: 'whatsapp-official',
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
  console.log(`✅ WhatsApp Business API service fully initialized`);
  console.log(`📡 Webhook URL pattern: http://localhost:${PORT}/webhook/v1/:clientId`);
  console.log(`💬 Message API pattern: http://localhost:${PORT}/api/v1/messages/:clientId/*`);
}).catch((error) => {
  console.error('❌ Failed to initialize WhatsApp Business API service:', error);
  console.error('⚠️  Server is still running for health checks, but features may be limited');
  // Don't exit - server is already running, health checks still work
});

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  // Stop accepting new connections
  server.close(async () => {
    console.log('✅ HTTP server closed');
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

