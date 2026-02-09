const crypto = require('crypto');
const clientManager = require('../services/client-manager');
const WhatsAppMessageController = require('./message.controller');
const WhatsAppOfficialMessageHandler = require('../services/message-handler');

/**
 * WhatsApp Business API Webhook Controller
 * Handles webhook verification and incoming message callbacks
 * Supports multi-client with clientId in route
 */
class WhatsAppWebhookController {
  constructor() {
    this.clientManager = clientManager;
    this.messageController = new WhatsAppMessageController();
    this.messageHandler = new WhatsAppOfficialMessageHandler();
  }

  /**
   * Verify webhook endpoint (GET)
   * Meta calls this to verify your webhook URL during setup
   * Route: /webhook/v1/:clientId? (clientId is optional)
   * - If clientId provided: uses client-specific verify token from database
   * - If clientId NOT provided: uses WA_WEBHOOK_VERIFY_TOKEN from env (for all clients)
   */
  async verify(req, res) {
    try {
      const { clientId } = req.params;
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      let verifyToken;
      let verificationContext;

      if (clientId) {
        // Client-specific verification: use token from database
        // Check if client exists
        const clientExists = await this.clientManager.clientExists(clientId);
        if (!clientExists) {
          console.error(`❌ Client ${clientId} not found`);
          return res.status(404).json({
            success: false,
            error: `Client ${clientId} not found or not active`
          });
        }

        // Get verify token from decrypted configuration
        verifyToken = await this.clientManager.getVerifyToken(clientId);
        verificationContext = `client ${clientId}`;
      } else {
        // Global verification for /webhook/v1 (all clients): use env variable
        verifyToken = process.env.WA_WEBHOOK_VERIFY_TOKEN;
        
        if (!verifyToken) {
          console.error(`❌ WA_WEBHOOK_VERIFY_TOKEN not set in environment`);
          return res.status(500).json({
            success: false,
            error: 'Webhook verification not configured. Please set WA_WEBHOOK_VERIFY_TOKEN environment variable.'
          });
        }
        
        verificationContext = 'all clients (global)';
      }

      console.log(`🔍 Webhook verification attempt for ${verificationContext} - mode: ${mode}, token match: ${token === verifyToken}`);

      // Per Meta's documentation: If the values match, respond with HTTP status 200 and hub.challenge value
      // If invalid, respond with a 400-level HTTP status code
      if (mode === 'subscribe' && token === verifyToken) {
        console.log(`✅ Webhook verified for ${verificationContext}`);
        // Return 200 with challenge value as plain text (not JSON)
        res.status(200).send(challenge);
      } else {
        console.error(`❌ Webhook verification failed for ${verificationContext} - mode: ${mode}, token match: ${token === verifyToken}`);
        // Return 403 (Forbidden) for invalid verification
        res.sendStatus(403);
      }
    } catch (error) {
      console.error('❌ Webhook verification error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }

  /**
   * Handle incoming webhook events (POST)
   * Meta sends message updates, delivery status, read receipts, etc.
   * Route: /webhook/v1/:clientId (clientId is optional - will be auto-detected from phone_number_id in metadata)
   */
  async handleWebhook(req, res) {
    try {
      let clientId = req.params.clientId;
      const body = req.body; // Parsed JSON body (for processing)
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(body)); // Raw body for signature verification

      // Extract phone_number_id from webhook metadata (single source of truth for client identification)
      const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      
      // Always use phone_number_id from metadata to identify the correct client (single source of truth)
      if (phoneNumberId) {
        const foundClientId = await this.clientManager.findClientIdByPhoneNumberId(phoneNumberId);
        
        if (foundClientId) {
          // Use the clientId found from phone_number_id (this is the correct one)
          // Route clientId is ignored when phone_number_id is available in metadata
          if (clientId && clientId !== foundClientId) {
            console.log(`ℹ️  Route clientId "${clientId}" ignored. Using client "${foundClientId}" identified from phone_number_id "${phoneNumberId}" in webhook metadata.`);
          }
          clientId = foundClientId;
          console.log(`✅ Processing webhook for client "${clientId}" (identified from phone_number_id: ${phoneNumberId})`);
        } else {
          console.error(`❌ Could not find clientId for phone_number_id: ${phoneNumberId}`);
          return res.status(404).json({
            success: false,
            error: `Could not identify client for phone_number_id: ${phoneNumberId}. Please ensure client is created with this phone_number_id.`
          });
        }
      } else {
        // No phone_number_id in metadata - fall back to route parameter if provided
        if (!clientId) {
          return res.status(400).json({
            success: false,
            error: 'clientId is required in route or phone_number_id must be present in webhook metadata'
          });
        }
        console.log(`ℹ️  No phone_number_id in webhook metadata, using route clientId: ${clientId}`);
      }

      // Check if client exists
      const clientExists = await this.clientManager.clientExists(clientId);
      if (!clientExists) {
        console.error(`❌ Client ${clientId} not found`);
        return res.status(404).json({
          success: false,
          error: `Client ${clientId} not found or not active`
        });
      }

      // Verify webhook signature using client-specific app_secret
      // Meta requires HMAC-SHA256 signature validation per their documentation
      const signature = req.headers['x-hub-signature-256'];
      
      // Log all relevant headers for debugging
      const relevantHeaders = {
        'x-hub-signature-256': req.headers['x-hub-signature-256'],
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'host': req.headers['host']
      };
      
      if (signature) {
        try {
          const appSecret = await this.clientManager.getAppSecret(clientId);
          if (!appSecret) {
            console.warn(`⚠️ App secret not configured for client ${clientId}, skipping signature verification`);
          } else {
            const rawBodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
            const isValid = this.verifySignature(rawBody, body, signature, appSecret);
            if (!isValid) {
              // Log detailed signature verification failure info (only on failure)
              const expectedSignature = 'sha256=' + crypto
                .createHmac('sha256', appSecret)
                .update(rawBodyString)
                .digest('hex');
              
              console.error(`❌ [${clientId}] Invalid webhook signature`);
              console.error(`   Received: ${signature.substring(0, 20)}...`);
              console.error(`   Expected: ${expectedSignature.substring(0, 20)}...`);
              console.error(`   Body length: ${rawBodyString.length} bytes`);
              return res.sendStatus(403);
            } else {
              console.log(`✅ [${clientId}] Webhook signature verified`);
            }
          }
        } catch (error) {
          console.error(`❌ [${clientId}] Error verifying webhook signature:`, error.message);
          return res.sendStatus(403);
        }
      } else {
        console.warn(`⚠️ [${clientId}] No X-Hub-Signature-256 header found, skipping signature verification`);
      }

      // Extract phone_number_id from metadata for logging
      const phoneNumberIdFromMetadata = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      const field = body?.entry?.[0]?.changes?.[0]?.field || 'unknown';
      const hasMessages = !!body?.entry?.[0]?.changes?.[0]?.value?.messages;
      const hasStatuses = !!body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      
      // Log only essential info instead of full body
      console.log(`📨 [${clientId}] Webhook received - field: ${field}, hasMessages: ${hasMessages}, hasStatuses: ${hasStatuses}${phoneNumberIdFromMetadata ? `, phone_number_id: ${phoneNumberIdFromMetadata}` : ''}`);

      // Meta sends a 200 response immediately, then processes the webhook
      res.sendStatus(200);

      // Process webhook events
      if (body.object === 'whatsapp_business_account') {
        for (const entry of (body.entry || [])) {
          for (const change of (entry.changes || [])) {
            // Meta can send status updates in 'messages' field with 'statuses' array
            // or in 'message_status' field. Check for statuses first.
            if (change.field === 'messages') {
              // Check if this is actually a status update (has statuses array) or incoming message (has messages array)
              if (change.value?.statuses && Array.isArray(change.value.statuses)) {
                // Status update sent via messages field
                await this.handleStatusChange(clientId, change.value);
              } else if (change.value?.messages && Array.isArray(change.value.messages)) {
                // Actual incoming message
                this.handleMessageChange(clientId, change.value);
              } else {
                console.log(`⚠️ Unknown webhook payload structure in 'messages' field for client ${clientId}`);
              }
            } else if (change.field === 'message_status') {
              // Status update in dedicated message_status field
              await this.handleStatusChange(clientId, change.value);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Webhook handling error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }

  /**
   * Handle incoming messages
   */
  async handleMessageChange(clientId, value) {
    if (value.messages) {
      // Extract metadata for logging/verification
      const metadata = value.metadata;
      
      // Process messages sequentially to avoid race conditions
      for (const message of value.messages) {
        const phoneNumberId = metadata?.phone_number_id;
        
        console.log(`📩 New message received for client ${clientId}${phoneNumberId ? ` (phone_number_id: ${phoneNumberId})` : ''}:`, {
          from: message.from,
          type: message.type,
          messageId: message.id,
          timestamp: message.timestamp,
          phoneNumberIdFromMetadata: phoneNumberId || 'N/A'
        });

        // Process all message types using the message handler (similar to WPPConnect)
        await this.messageHandler.handleIncomingMessage(
          clientId,
          message,
          value.contacts?.[0] || {},
          metadata
        );
      }
    }
  }

  /**
   * Handle delivery/read status updates
   * When status is 'read', produces message:read event to stream for Weaviate lastReadAt update
   */
  async handleStatusChange(clientId, value) {
    const statuses = value.statuses || [];

    if (statuses.length > 0) {
      for (const status of statuses) {
        if (status.status === 'failed') {
          console.log(`❌ [${clientId}] Message failed: ${status.id?.substring(0, 20) || 'unknown'}... (recipient: ${status.recipient_id})`);
          if (status.errors?.length > 0) {
            status.errors.forEach((err) => console.error(`   Error: ${err.code} - ${err.title || err.message}`));
          }
        }
        // When user reads our message, produce message:read for Weaviate lastReadAt update
        if (status.status === 'read' && status.recipient_id) {
          try {
            const agentCode = await this.messageHandler.getAgentForUser(clientId, status.recipient_id);
            if (agentCode && (process.env.VALKEY_HOST || process.env.REDIS_HOST)) {
              const { StreamProducer } = require('../../pubsub/client/producer');
              const producer = new StreamProducer();
              await producer.connect();
              const readAt = status.timestamp ? new Date(parseInt(status.timestamp) * 1000).toISOString() : new Date().toISOString();
              await producer.publishMessageRead({
                clientId,
                platform: 'wa-official',
                userIdentifier: status.recipient_id,
                agentCode,
                readAt
              });
            }
          } catch (err) {
            console.warn(`⚠️ [${clientId}] Failed to publish message:read:`, err.message);
          }
        }
      }
    }
  }


  /**
   * Verify webhook signature (HMAC SHA256)
   * Per Meta's documentation: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
   * 
   * Validation: Generate an HMAC-SHA256 hash using the RAW JSON payload string as the message input 
   * and your app secret as the secret key. Compare your generated hash to the hash assigned 
   * to the X-Hub-Signature-256 header (everything after sha256=).
   * 
   * IMPORTANT: Meta calculates the signature on the RAW body string, NOT on parsed/re-stringified JSON.
   * JSON.stringify() can produce different strings due to key ordering and whitespace.
   * 
   * @param {Buffer|String} rawBody - The RAW request body (Buffer or String) - MUST be raw, not parsed
   * @param {Object} parsedBody - The parsed JSON body (for logging/debugging only)
   * @param {string} signature - The X-Hub-Signature-256 header value (format: "sha256=<hash>")
   * @param {string} appSecret - The app secret from client configuration (decrypted from vault)
   * @returns {boolean} - True if signature is valid, false otherwise
   */
  verifySignature(rawBody, parsedBody, signature, appSecret) {
    if (!appSecret) {
      return false; // Cannot verify without app secret
    }

    // Convert raw body to string if it's a Buffer
    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    
    // Generate expected signature using RAW body string (exactly as Meta sends it)
    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', appSecret)
      .update(bodyString)
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      // If signature format is invalid, return false
      return false;
    }
  }
}

module.exports = WhatsAppWebhookController;

