require('dotenv').config();
const express = require('express');
const WhatsAppOfficialApp = require('./app');

const PORT = process.env.PORT || process.env.WA_OFFICIAL_PORT || 3004;

// Initialize the WhatsApp Business API app
const app = new WhatsAppOfficialApp();
app.initialize();

// Start the server
app.getApp().listen(PORT, () => {
  console.log(`🚀 WhatsApp Business API service running on port ${PORT}`);
  console.log(`📡 Webhook URL pattern: http://localhost:${PORT}/webhook/v1/:clientId`);
  console.log(`💬 Message API pattern: http://localhost:${PORT}/api/v1/messages/:clientId/*`);
});

