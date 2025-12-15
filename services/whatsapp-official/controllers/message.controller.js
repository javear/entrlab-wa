const axios = require('axios');
const clientManager = require('../services/client-manager');

/**
 * WhatsApp Business API Message Controller
 * Handles sending messages via Meta's REST API
 * Supports multi-client with clientId in route
 */
class WhatsAppMessageController {
  constructor() {
    this.clientManager = clientManager;
    this.apiVersion = process.env.WA_API_VERSION || 'v21.0';
  }

  /**
   * Handle API request errors and clear cache on authentication failures
   * @private
   */
  handleApiError(clientId, error, requestUrl, requestPayload) {
    const statusCode = error.response?.status;
    
    // Log error details
    console.error(`❌ [${clientId}] Error response from Meta API:`);
    console.error(`   Status: ${statusCode || 'N/A'} ${error.response?.statusText || ''}`);
    console.error(`   URL: ${requestUrl}`);
    console.error(`   Request Payload:`, JSON.stringify(requestPayload, null, 2));
    console.error(`   Response Headers:`, error.response?.headers || {});
    console.error(`   Response Data:`, JSON.stringify(error.response?.data || {}, null, 2));
    console.error(`   Error Message:`, error.message);
    
    // If we get 401/403 (unauthorized/forbidden), clear the cache for this client
    // This ensures we fetch fresh credentials on next attempt (in case token was updated)
    if (statusCode === 401 || statusCode === 403) {
      console.warn(`⚠️ [${clientId}] Authentication error (${statusCode}), clearing client cache...`);
      this.clientManager.clearCache(clientId);
      console.log(`✅ [${clientId}] Cache cleared. Next request will fetch fresh credentials from database.`);
    }
  }

  /**
   * Send a text message programmatically (can be called from webhook or API)
   * @param {string} clientId - Client ID
   * @param {string} to - Recipient phone number
   * @param {string} message - Message text
   * @returns {Promise<Object>} - Response data with messageId
   */
  async sendTextMessage(clientId, to, message) {
    if (!clientId || !to || !message) {
      throw new Error('Missing required parameters: clientId, to, message');
    }

    // Get client credentials from decrypted configuration
    const accessToken = await this.clientManager.getAccessToken(clientId);
    const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
    const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;
    const requestUrl = `${baseUrl}/messages`;

    const requestPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: {
        preview_url: false,
        body: message
      }
    };

    const requestHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    // Log request details
    console.log(`📤 [${clientId}] Request to Meta API:`);
    console.log(`   URL: ${requestUrl}`);
    console.log(`   Method: POST`);
    console.log(`   Phone Number ID: ${phoneNumberId}`);
    console.log(`   Access Token: ${accessToken ? `${accessToken.substring(0, 20)}...` : 'MISSING'}`);
    console.log(`   To: ${to}`);
    console.log(`   Message: ${message}`);
    console.log(`   Payload:`, JSON.stringify(requestPayload, null, 2));

    try {
      const response = await axios.post(
        requestUrl,
        requestPayload,
        {
          headers: requestHeaders
        }
      );

      // Log successful response
      console.log(`✅ [${clientId}] Response from Meta API:`);
      console.log(`   Status: ${response.status} ${response.statusText}`);
      console.log(`   Message ID: ${response.data.messages?.[0]?.id || 'N/A'}`);
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));

      return {
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      };
    } catch (error) {
      this.handleApiError(clientId, error, requestUrl, requestPayload);
      throw error;
    }
  }

  /**
   * Send a text message (API endpoint handler)
   * POST /api/v1/messages/:clientId/text
   */
  async sendText(req, res) {
    try {
      const { clientId } = req.params;
      const { to, message } = req.body;

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required in route parameter'
        });
      }

      if (!to || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, message'
        });
      }

      const result = await this.sendTextMessage(clientId, to, message);
      res.json(result);
    } catch (error) {
      console.error(`❌ Error sending text message for client ${req.params.clientId}:`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message
      });
    }
  }

  /**
   * Send a media message (image, video, document, audio)
   * POST /api/v1/messages/:clientId/media
   */
  async sendMedia(req, res) {
    try {
      const { clientId } = req.params;
      const { to, type, mediaUrl, caption } = req.body;

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required in route parameter'
        });
      }

      if (!to || !type || !mediaUrl) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, type, mediaUrl'
        });
      }

      // Get client credentials from decrypted configuration
      const accessToken = await this.clientManager.getAccessToken(clientId);
      const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
      const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;

      const messagePayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: type
      };

      // Add media-specific fields
      if (type === 'image') {
        messagePayload.image = {
          link: mediaUrl,
          caption: caption || ''
        };
      } else if (type === 'video') {
        messagePayload.video = {
          link: mediaUrl,
          caption: caption || ''
        };
      } else if (type === 'document') {
        messagePayload.document = {
          link: mediaUrl,
          caption: caption || '',
          filename: req.body.filename || 'document'
        };
      } else if (type === 'audio') {
        messagePayload.audio = {
          link: mediaUrl
        };
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid media type. Supported: image, video, document, audio'
        });
      }

      const requestUrl = `${baseUrl}/messages`;
      const response = await axios.post(
        requestUrl,
        messagePayload,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Media message sent to ${to} via client ${clientId}:`, response.data);

      res.json({
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      });
    } catch (error) {
      const requestUrl = `${baseUrl}/messages`;
      const payload = typeof messagePayload !== 'undefined' ? messagePayload : { to, type, mediaUrl };
      this.handleApiError(clientId, error, requestUrl, payload);
      console.error(`❌ Error sending media message for client ${req.params.clientId}:`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message
      });
    }
  }

  /**
   * Send a template message
   * POST /api/v1/messages/:clientId/template
   */
  async sendTemplate(req, res) {
    try {
      const { clientId } = req.params;
      const { to, templateName, languageCode, components } = req.body;

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required in route parameter'
        });
      }

      if (!to || !templateName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, templateName'
        });
      }

      // Get client credentials from decrypted configuration
      const accessToken = await this.clientManager.getAccessToken(clientId);
      const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
      const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode || 'en_US'
          }
        }
      };

      if (components) {
        payload.template.components = components;
      }

      const requestUrl = `${baseUrl}/messages`;
      const response = await axios.post(
        requestUrl,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Template message sent to ${to} via client ${clientId}:`, response.data);

      res.json({
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      });
    } catch (error) {
      const requestUrl = `${baseUrl}/messages`;
      const requestPayload = typeof payload !== 'undefined' ? payload : { to, templateName, languageCode };
      this.handleApiError(clientId, error, requestUrl, requestPayload);
      console.error(`❌ Error sending template message for client ${req.params.clientId}:`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message
      });
    }
  }

  /**
   * Get message status
   * GET /api/v1/messages/:clientId/status/:messageId
   */
  async getMessageStatus(req, res) {
    try {
      const { messageId } = req.params;

      // Note: Meta doesn't provide a direct endpoint to check message status
      // Status updates are received via webhooks
      res.json({
        success: true,
        message: 'Message status is received via webhooks. Check webhook events for status updates.',
        messageId: messageId
      });
    } catch (error) {
      console.error('❌ Error getting message status:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = WhatsAppMessageController;

