require('dotenv').config();
const PubSubApp = require('./app');

const PORT = process.env.PUBSUB_PORT || 3005;

// Initialize the Pub/Sub app
const app = new PubSubApp();
app.initialize().then(() => {
  // Start the server
  app.getApp().listen(PORT, () => {
    console.log(`🚀 Pub/Sub service running on port ${PORT}`);
    console.log(`📡 Webhook registration: http://localhost:${PORT}/api/v1/webhooks`);
    console.log(`📊 Stream consumer: http://localhost:${PORT}/api/v1/streams`);
    console.log(`📨 Stream: ${process.env.VALKEY_STREAM_NAME || 'whatsapp:events'}`);
  });
}).catch((error) => {
  console.error('❌ Failed to initialize Pub/Sub service:', error);
  process.exit(1);
});
