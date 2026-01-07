# Webhook Registration Guide

This guide explains how to register your endpoint to receive webhook events from the pub/sub service.

## Overview

The pub/sub service can deliver events to your registered webhook endpoints. Events are delivered via HTTP POST requests with JSON payloads.

## Supported Event Types

- `message:incoming` - Published when a new message is received from a WhatsApp user
- `ai:response` - Published when an AI response is generated and sent

## Step 1: Prepare Your Webhook Endpoint

Your webhook endpoint must:
- Be publicly accessible (or reachable from the server)
- Accept HTTP POST requests
- Accept `application/json` content type
- Return a 2xx status code for successful delivery

### Example Webhook Endpoint (Node.js/Express)

```javascript
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhooks/whatsapp', (req, res) => {
  const { event, timestamp } = req.body;
  
  console.log('Received webhook event:', event.eventType);
  console.log('Event data:', event);
  
  // Process the event
  if (event.eventType === 'message:incoming') {
    console.log(`New message from ${event.userIdentifier}: ${event.content}`);
  } else if (event.eventType === 'ai:response') {
    console.log(`AI response sent to ${event.userIdentifier}`);
  }
  
  // Always return 200 OK to acknowledge receipt
  res.status(200).json({ received: true });
});

app.listen(3000, () => {
  console.log('Webhook server listening on port 3000');
});
```

### Using ngrok for Local Testing

```bash
# Install ngrok: https://ngrok.com/
ngrok http 3000

# Use the ngrok URL (e.g., https://abc123.ngrok.io) as your webhook URL
```

## Step 2: Register Your Webhook

### Using cURL

```bash
# Generate a JWT token first
node scripts/generate-token.js

# Register the webhook
curl -X POST "http://localhost:3003/api/v1/pubsub/webhooks" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/webhooks/whatsapp",
    "eventTypes": ["message:incoming", "ai:response"],
    "secret": "your-webhook-secret-here",
    "headers": {
      "X-Custom-Header": "optional-custom-value"
    }
  }'
```

### Request Body Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Your webhook endpoint URL |
| `eventTypes` | array | No | Events to subscribe to (default: all events) |
| `secret` | string | No | Secret for signature verification |
| `headers` | object | No | Custom headers to include in requests |

### Response

**Success (201 Created):**
```json
{
  "success": true,
  "webhook": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "url": "https://your-domain.com/webhooks/whatsapp",
    "eventTypes": ["message:incoming", "ai:response"],
    "status": "active",
    "createdAt": "2024-01-15T10:30:45.123Z"
  }
}
```

## Step 3: Verify Webhook Registration

### List All Webhooks

```bash
curl -X GET "http://localhost:3003/api/v1/pubsub/webhooks" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Get Specific Webhook

```bash
curl -X GET "http://localhost:3003/api/v1/pubsub/webhooks/{webhook-id}" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Step 4: Test Your Webhook

### Test Webhook Delivery

```bash
curl -X POST "http://localhost:3003/api/v1/pubsub/webhooks/{webhook-id}/test" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "eventType": "test",
      "message": "This is a test event"
    }
  }'
```

## Webhook Payload Format

When events are delivered, your endpoint will receive a POST request with this structure:

```json
{
  "event": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "messageId": "message-id",
    "messageType": "text",
    "content": "Hello, how are you?",
    "metadata": {
      "sender": { ... },
      "message": { ... }
    }
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### Headers Included

- `Content-Type: application/json`
- `User-Agent: WhatsApp-PubSub/1.0`
- `X-Webhook-Signature: sha256=<signature>` (if secret is provided)
- Any custom headers you specified during registration

## Webhook Signature Verification

If you provided a `secret` during registration, you should verify the signature:

### Node.js Example

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(JSON.stringify(payload)).digest('hex');
  return signature === `sha256=${expectedSignature}`;
}

app.post('/webhooks/whatsapp', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const secret = 'your-webhook-secret-here';
  
  if (signature && !verifyWebhookSignature(req.body, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Process webhook...
  res.status(200).json({ received: true });
});
```

## Update Webhook

```bash
curl -X PUT "http://localhost:3003/api/v1/pubsub/webhooks/{webhook-id}" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-new-domain.com/webhooks/whatsapp",
    "eventTypes": ["message:incoming"],
    "status": "active"
  }'
```

## Delete Webhook

```bash
curl -X DELETE "http://localhost:3003/api/v1/pubsub/webhooks/{webhook-id}" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Webhook Status

Webhooks have the following statuses:
- `active` - Webhook is active and will receive events
- `inactive` - Webhook is disabled and will not receive events

## Webhook Statistics

Each webhook tracks:
- `successCount` - Number of successful deliveries
- `failureCount` - Number of failed deliveries
- `lastTriggered` - Timestamp of last delivery attempt

## Troubleshooting

### Webhook Not Receiving Events

1. **Check webhook status**: Make sure the webhook is `active`
2. **Verify URL**: Ensure your endpoint URL is correct and accessible
3. **Check event types**: Verify you're subscribed to the event types you expect
4. **Test endpoint**: Use the test endpoint to verify connectivity
5. **Check logs**: Review server logs for delivery errors

### Common Errors

- **401 Unauthorized**: Invalid or expired JWT token
- **404 Not Found**: Webhook ID doesn't exist
- **400 Bad Request**: Invalid request body (missing URL, invalid format, etc.)
- **Delivery failures**: Check that your endpoint is accessible and returns 2xx status codes

## Complete Example

### 1. Create a simple webhook server

```javascript
// webhook-server.js
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhooks/whatsapp', (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ received: true });
});

app.listen(3000, () => {
  console.log('Webhook server running on port 3000');
});
```

### 2. Start your webhook server

```bash
node webhook-server.js
```

### 3. Expose it (for local testing)

```bash
ngrok http 3000
# Copy the ngrok URL, e.g., https://abc123.ngrok.io
```

### 4. Register the webhook

```bash
curl -X POST "http://localhost:3003/api/v1/pubsub/webhooks" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://abc123.ngrok.io/webhooks/whatsapp",
    "eventTypes": ["message:incoming", "ai:response"],
    "secret": "my-secret-key-123"
  }'
```

### 5. Send a test message

Send a WhatsApp message, and you should see events delivered to your webhook endpoint!


