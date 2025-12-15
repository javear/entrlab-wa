# WhatsApp Business API Service

This service implements the official Meta WhatsApp Business API for sending and receiving WhatsApp messages.

## Setup

### Prerequisites

1. Meta Business Account
2. WhatsApp Business Account
3. Meta App with WhatsApp Business API enabled
4. Access Token and Phone Number ID from Meta

### Environment Variables

Add these to your `.env` file:

```env
# Server Configuration
WA_OFFICIAL_PORT=3004

# MongoDB Connection (for client configurations)
MONGODB_URI=mongodb://localhost:27017/whatsapp-bot

# Vault Configuration (for encrypting/decrypting client credentials)
VAULT_ADDR=http://your-vault-server:8200
VAULT_TOKEN=your_vault_token
VAULT_KEY_NAME=automark-key  # Optional, defaults to 'automark-key'

# WhatsApp Business API Global Settings (optional, used for webhook signature verification)
WA_APP_SECRET=your_app_secret_here  # Optional, for webhook signature verification
WA_API_VERSION=v21.0
```

**Note:** Client-specific credentials (access_token, phone_number_id, verify_token, app_secret) are stored encrypted in MongoDB and retrieved per-request. Create clients using the `/api/v1/platform/clients` endpoint. The `app_secret` is required for webhook signature verification (HMAC-SHA256) per Meta's security requirements.

### Webhook Configuration (Multi-Client)

The service supports multiple WhatsApp Business API clients. Each client has its own webhook endpoint.

1. Create a client first using `/api/v1/platform/clients` endpoint (from main API)
2. Set up your webhook URL in Meta App Dashboard for each client:
   - URL: `https://your-domain.com/webhook/v1/{clientId}`
   - Verify Token: The `verifyToken` returned when creating the client (from decrypted vault configuration)
   - Subscribe to: `messages` and `message_status` fields

3. Verify webhook signature (required for security):
   - Each client's `app_secret` (from decrypted vault configuration) is used to verify HMAC-SHA256 signatures
   - The `app_secret` should be provided when creating the client via `/api/v1/platform/clients`
   - Webhook POST requests are automatically validated using the client's app_secret

## Running the Service

```bash
npm run waofficial-dev
```

## API Endpoints

All endpoints require a `clientId` parameter that identifies which WhatsApp Business API client to use. Client credentials are stored encrypted in MongoDB and decrypted on-demand using Vault.

### Webhook (Multi-Client)

- `GET /webhook/v1/:clientId` - Webhook verification (Meta calls this during setup)
- `POST /webhook/v1/:clientId` - Receive incoming messages and status updates

The `clientId` must match a client created via `/api/v1/platform/clients` with platform `wa-official`.

### Messaging (Multi-Client)

- `POST /api/v1/messages/:clientId/text` - Send text message
  ```json
  {
    "to": "1234567890",
    "message": "Hello, World!"
  }
  ```

- `POST /api/v1/messages/:clientId/media` - Send media message
  ```json
  {
    "to": "1234567890",
    "type": "image",
    "mediaUrl": "https://example.com/image.jpg",
    "caption": "Optional caption"
  }
  ```

- `POST /api/v1/messages/:clientId/template` - Send template message
  ```json
  {
    "to": "1234567890",
    "templateName": "hello_world",
    "languageCode": "en_US",
    "components": []
  }
  ```

- `GET /api/v1/messages/:clientId/status/:messageId` - Get message status info

Each request uses the specific client's credentials (access_token, phone_number_id) from the encrypted MongoDB configuration.

## Documentation

- [WhatsApp Business API Documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)
- [Webhooks Documentation](https://developers.facebook.com/docs/graph-api/webhooks)
- [Messaging API Reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages)

