# Webhook/Producer Payload Examples

This document shows the exact payload structure that webhooks receive and what's published to the stream.

## Webhook Payload Format

When a webhook is triggered, it receives a POST request with the following structure:

```json
{
  "event": {
    // Event data (see examples below)
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

**Headers:**
- `Content-Type: application/json`
- `User-Agent: WhatsApp-PubSub/1.0`
- `X-Webhook-Signature: sha256=<signature>` (if webhook secret is configured)

---

## Event Type: `message:incoming`

Published when a new message is received from a WhatsApp user.

### WPPConnect Platform

```json
{
  "event": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "messageId": "3EB0C767F26EE0E60A5B",
    "messageType": "text",
    "content": "[#messageid:3EB0C767F26EE0E60A5B#message-timestamp:2024-01-15 10:30:45] Hello, how are you?",
    "metadata": {
      "sender": {
        "name": "John Doe",
        "pushname": "John",
        "formattedName": "John Doe",
        "isBusiness": false,
        "isEnterprise": false
      },
      "message": {
        "from": "6281234567890@c.us",
        "timestamp": 1705317045,
        "hasMedia": false,
        "mediaUrls": []
      }
    }
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

#### WPPConnect with Media

```json
{
  "event": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "messageId": "3EB0C767F26EE0E60A5B",
    "messageType": "image",
    "content": "[#messageid:3EB0C767F26EE0E60A5B#message-timestamp:2024-01-15 10:30:45] Photo with caption\nMedia attached:\n- @[https://tmpfile.link/abc123]",
    "metadata": {
      "sender": {
        "name": "John Doe",
        "pushname": "John",
        "formattedName": "John Doe",
        "isBusiness": false,
        "isEnterprise": false
      },
      "message": {
        "from": "6281234567890@c.us",
        "timestamp": 1705317045,
        "hasMedia": true,
        "mediaUrls": [
          "https://tmpfile.link/abc123"
        ]
      }
    }
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### WhatsApp Official Platform

```json
{
  "event": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "cs-gue",
    "platform": "wa-official",
    "userIdentifier": "6282121547121",
    "messageId": "wamid.HBgNNjI4MjEyMTU0NzEyMRUCABIYFDNCQTIxQzg2MzE1M0JEQzU1MjZGAA==",
    "messageType": "text",
    "content": "[#messageid:wamid.HBgNNjI4MjEyMTU0NzEyMRUCABIYFDNCQTIxQzg2MzE1M0JEQzU1MjZGAA==#message-timestamp:2024-01-15 10:30:45] Hello, how are you?",
    "metadata": {
      "sender": {
        "name": "Jav",
        "phone": "6282121547121"
      },
      "message": {
        "from": "6282121547121",
        "timestamp": "1766371530",
        "phoneNumberId": "876852938848736",
        "hasMedia": false,
        "mediaUrls": []
      }
    }
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

#### WhatsApp Official with Media

```json
{
  "event": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "cs-gue",
    "platform": "wa-official",
    "userIdentifier": "6282121547121",
    "messageId": "wamid.HBgNNjI4MjEyMTU0NzEyMRUCABIYFDNCQTIxQzg2MzE1M0JEQzU1MjZGAA==",
    "messageType": "image",
    "content": "[#messageid:wamid...]#message-timestamp:2024-01-15 10:30:45] Check out this photo\nMedia attached:\n- @[https://tmpfile.link/xyz789]",
    "metadata": {
      "sender": {
        "name": "Jav",
        "phone": "6282121547121"
      },
      "message": {
        "from": "6282121547121",
        "timestamp": "1766371530",
        "phoneNumberId": "876852938848736",
        "hasMedia": true,
        "mediaUrls": [
          "https://tmpfile.link/xyz789"
        ]
      }
    }
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

---

## Event Type: `ai:response`

Published when an AI response is generated and sent to the user.

### WPPConnect Platform - Multiple Messages

```json
{
  "event": {
    "eventType": "ai:response",
    "timestamp": "2024-01-15T10:30:50.456Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "agentCode": "goa-konsul",
    "requestMessage": "Hello, how are you?",
    "response": {
      "messages": [
        {
          "type": "text",
          "text": "Hello! I'm doing great, thank you for asking."
        },
        {
          "type": "text",
          "text": "How can I help you today?"
        }
      ],
      "raw": {
        "result": {
          "content": {
            "object": [
              {
                "type": "text",
                "text": "Hello! I'm doing great, thank you for asking."
              },
              {
                "type": "text",
                "text": "How can I help you today?"
              }
            ]
          }
        }
      }
    },
    "metadata": {
      "processingTime": 5234
    }
  },
  "timestamp": "2024-01-15T10:30:50.456Z"
}
```

### WPPConnect Platform - Text Only Response

```json
{
  "event": {
    "eventType": "ai:response",
    "timestamp": "2024-01-15T10:30:50.456Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "agentCode": "goa-konsul",
    "requestMessage": "What's the weather?",
    "response": {
      "text": "The weather today is sunny with a temperature of 25°C.",
      "raw": {
        "result": {
          "content": {
            "text": "The weather today is sunny with a temperature of 25°C."
          }
        }
      }
    },
    "metadata": {
      "processingTime": 2341
    }
  },
  "timestamp": "2024-01-15T10:30:50.456Z"
}
```

### WPPConnect Platform - Rich Media Response

```json
{
  "event": {
    "eventType": "ai:response",
    "timestamp": "2024-01-15T10:30:50.456Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "agentCode": "goa-konsul",
    "requestMessage": "Show me a picture",
    "response": {
      "messages": [
        {
          "type": "text",
          "text": "Here's a picture for you!"
        },
        {
          "type": "image",
          "url": "https://example.com/image.jpg",
          "caption": "Beautiful sunset"
        },
        {
          "type": "video",
          "url": "https://example.com/video.mp4",
          "caption": "Video demonstration"
        }
      ],
      "raw": {
        "result": {
          "formatted": {
            "whatsapp": [
              {
                "type": "text",
                "text": "Here's a picture for you!"
              },
              {
                "type": "image",
                "url": "https://example.com/image.jpg",
                "caption": "Beautiful sunset"
              },
              {
                "type": "video",
                "url": "https://example.com/video.mp4",
                "caption": "Video demonstration"
              }
            ]
          }
        }
      }
    },
    "metadata": {
      "processingTime": 7890
    }
  },
  "timestamp": "2024-01-15T10:30:50.456Z"
}
```

### WhatsApp Official Platform

```json
{
  "event": {
    "eventType": "ai:response",
    "timestamp": "2024-01-15T10:30:50.456Z",
    "clientId": "cs-gue",
    "platform": "wa-official",
    "userIdentifier": "6282121547121",
    "agentCode": "agent-3",
    "requestMessage": "[#messageid:wamid...]#message-timestamp:2024-01-15 10:30:45] Hello, how are you?",
    "response": {
      "messages": [
        {
          "type": "text",
          "text": "Hello! I'm doing great, thank you for asking."
        },
        {
          "type": "text",
          "text": "How can I help you today?"
        }
      ],
      "raw": {
        "result": {
          "formatted": {
            "whatsapp": [
              {
                "type": "text",
                "text": "Hello! I'm doing great, thank you for asking."
              },
              {
                "type": "text",
                "text": "How can I help you today?"
              }
            ]
          }
        }
      }
    },
    "metadata": {
      "processingTime": 5234
    }
  },
  "timestamp": "2024-01-15T10:30:50.456Z"
}
```

### WhatsApp Official Platform - Text Only

```json
{
  "event": {
    "eventType": "ai:response",
    "timestamp": "2024-01-15T10:30:50.456Z",
    "clientId": "cs-gue",
    "platform": "wa-official",
    "userIdentifier": "6282121547121",
    "agentCode": "agent-3",
    "requestMessage": "[#messageid:wamid...]#message-timestamp:2024-01-15 10:30:45] What's the weather?",
    "response": {
      "messages": null,
      "text": "The weather today is sunny with a temperature of 25°C.",
      "raw": {
        "result": {
          "content": {
            "text": "The weather today is sunny with a temperature of 25°C."
          }
        }
      }
    },
    "metadata": {
      "processingTime": 2341
    }
  },
  "timestamp": "2024-01-15T10:30:50.456Z"
}
```

---

## Message Types Supported

### Incoming Message Types

- `text` - Text message
- `image` - Image with optional caption
- `video` - Video with optional caption
- `audio` - Audio/voice message
- `document` - Document/file
- `sticker` - Sticker
- `location` - Location sharing
- `livelocation` - Live location sharing
- `reaction` - Message reaction

### AI Response Message Types

The `response.messages` array can contain objects with these types:

- `text` - Plain text message
- `image` - Image with optional caption (`url`, `caption`)
- `video` - Video with optional caption (`url`, `caption`)
- `audio` - Audio file (`url`)
- `file` - Generic file (`url`, `caption`)
- `sticker` - Sticker (`url`)
- `reaction` - Reaction to a message (`messageId`, `emoji`)
- `block` - Block user (triggers needAttention)
- `pause` - Pause user (triggers needAttention)
- `stop-response` - Stop response indicator

---

## Webhook Signature Verification

If a webhook secret is configured, the webhook includes a signature header:

```
X-Webhook-Signature: sha256=<hmac_sha256_signature>
```

To verify the signature:

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(JSON.stringify(payload)).digest('hex');
  return signature === `sha256=${expectedSignature}`;
}

// Usage
const signature = req.headers['x-webhook-signature'];
const isValid = verifyWebhookSignature(req.body, signature, webhookSecret);
```

---

## Stream Entry Format (Raw)

When reading directly from the stream (not via webhook), entries are in this format:

```json
{
  "id": "1705317045123-0",
  "data": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "my-client-id",
    "platform": "wpp",
    "userIdentifier": "6281234567890",
    "messageId": "3EB0C767F26EE0E60A5B",
    "messageType": "text",
    "content": "Hello, how are you?",
    "metadata": "{...}" // JSON stringified
  }
}
```

Note: In the stream, nested objects (like `metadata`) are stored as JSON strings and need to be parsed.

---

## Testing Webhooks

You can test your webhook using the test endpoint:

```bash
curl -X POST http://localhost:3005/api/v1/webhooks/<webhook-id>/test \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "eventType": "test",
      "test": true,
      "message": "This is a test event"
    }
  }'
```

Or use the default test event:

```bash
curl -X POST http://localhost:3005/api/v1/webhooks/<webhook-id>/test
```

